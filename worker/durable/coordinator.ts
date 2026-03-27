import { DurableObject } from "cloudflare:workers";
import {
  COORDINATOR_OBJECT_NAME,
  DEFAULT_COMPLETED_JOB_RETENTION_MS,
  DISPATCH_LEASE_TIMEOUT_MS,
  DEFAULT_MAX_PROOF_TOTAL_WALL_TIME_MS,
  DEFAULT_MAX_PROVER_RUN_TIME_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_PROVER_POLL_INTERVAL_MS,
  MAX_TOTAL_PROVER_ATTEMPTS,
  MAX_CLAIM_AUTO_RETRIES,
  CLAIM_AUTO_RETRY_COOLDOWN_MS,
  REPLAY_DEDUPE_WINDOW_MS,
} from "../constants";
import { resolveBoundlessConfig } from "../boundless/config";
import { BoundlessClient, fetchBoundlessCycles } from "../boundless/sdk/client";
import { fetchEthPriceUsd, weiToUsd } from "../boundless/pricing";
import { unpinInput } from "../boundless/storage";
import type { WorkerEnv } from "../env";
import { resultKey, tapeKey } from "../keys";
import { pollProverOnce } from "../prover/client";
import { parseClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import type {
  ClaimAttempt,
  CreateJobAccepted,
  ProofJobRecord,
  ProofResultSummary,
  ProverAttempt,
  ProverBackend,
  ProverPollResult,
  ProofTimeoutPhase,
  PublicProofJob,
  ProofTapeInfo,
} from "../types";
import {
  isTerminalProofStatus,
  nowIso,
  parseInteger,
  retryDelaySeconds,
  safeErrorMessage,
} from "../utils";

const DEFAULT_BOUNDLESS_CHAIN_ID = "8453"; // Base mainnet
const PERMANENT_REPLAY_LOCK_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
type ReplayRegistryState = "reserved" | "dispatching" | "dispatched";

interface ReplayRegistryRow {
  replay_hash: string;
  proof_job_id: string;
  claimant_address: string;
  seed: number;
  frame_count: number;
  state: ReplayRegistryState;
  locked_backend: ProverBackend | null;
  first_seen_at: string;
  expires_at: string;
  dispatch_started_at: string | null;
}

function replayRowIsPermanentlyLocked(row: ReplayRegistryRow): boolean {
  return row.state === "dispatching" || row.state === "dispatched";
}

function isSupersededProofJob(job: ProofJobRecord): boolean {
  return (
    (job.status === "succeeded" && job.claim.txHash === "superseded-by-higher-score") ||
    (job.status === "failed" && job.errorCode === "superseded_by_higher_score")
  );
}

function getProofRetryBlockedReason(job: ProofJobRecord): PublicProofJob["proofRetryBlockedReason"] {
  if (job.status !== "failed") return "not_failed";
  if (job.result?.summary) return "has_result";
  if (isSupersededProofJob(job)) return "superseded";
  if (job.replayLockState === "dispatching" || job.replayLockState === "dispatched") {
    return "replay_locked";
  }
  return null;
}

function withProofRetryEligibility(job: ProofJobRecord): ProofJobRecord {
  const blockedReason = getProofRetryBlockedReason(job);
  job.proofRetryBlockedReason = blockedReason;
  job.canRetryProof = blockedReason === null;
  return job;
}

export function coordinatorStub(env: WorkerEnv): DurableObjectStub<ProofCoordinatorDO> {
  const id = env.PROOF_COORDINATOR.idFromName(COORDINATOR_OBJECT_NAME);
  return env.PROOF_COORDINATOR.get(id);
}

export function asPublicJob(job: ProofJobRecord): PublicProofJob {
  const publicJob = withProofRetryEligibility({ ...job });
  const proverAttempts = (job.proverAttempts ?? []).map((a) => ({
    ...a,
    errorDetail: a.errorDetail ?? null,
    errorCode: a.errorCode ?? null,
    actualCostUsd: a.actualCostUsd != null && a.actualCostUsd <= 1000 ? a.actualCostUsd : null,
    minPriceWei: a.minPriceWei ?? null,
    maxPriceWei: a.maxPriceWei ?? null,
    fundingModeUsed: a.fundingModeUsed ?? null,
    marketBalanceBeforeWei: a.marketBalanceBeforeWei ?? null,
    autoDepositWei: a.autoDepositWei ?? null,
    proverAddress: a.proverAddress ?? null,
    fulfillmentTxHash: a.fulfillmentTxHash ?? null,
    programCycles: a.programCycles ?? null,
    totalCycles: a.totalCycles ?? null,
  }));

  return {
    jobId: publicJob.jobId,
    status: publicJob.status,
    createdAt: publicJob.createdAt,
    updatedAt: publicJob.updatedAt,
    completedAt: publicJob.completedAt,
    replayHash: publicJob.replayHash ?? null,
    replayLockState: publicJob.replayLockState ?? null,
    replayLockedBackend: publicJob.replayLockedBackend ?? null,
    tape: {
      sizeBytes: job.tape.sizeBytes,
      metadata: job.tape.metadata,
    },
    queue: {
      attempts: publicJob.queue.attempts,
      lastAttemptAt: publicJob.queue.lastAttemptAt,
      lastError: publicJob.queue.lastError,
      nextRetryAt: publicJob.queue.nextRetryAt,
      waitStartedAt: publicJob.queue.waitStartedAt ?? null,
      waitElapsedMs: publicJob.queue.waitElapsedMs ?? null,
    },
    prover: {
      jobId: publicJob.prover.jobId,
      status: publicJob.prover.status,
      statusUrl: publicJob.prover.statusUrl,
      segmentLimitPo2: publicJob.prover.segmentLimitPo2,
      lastPolledAt: publicJob.prover.lastPolledAt,
      pollingErrors: publicJob.prover.pollingErrors,
      ipfsCid: publicJob.prover.ipfsCid ?? null,
      runStartedAt: publicJob.prover.runStartedAt ?? null,
      runElapsedMs: publicJob.prover.runElapsedMs ?? null,
    },
    proverAttempts,
    claimAttempts: publicJob.claimAttempts ?? [],
    result: publicJob.result,
    claim: {
      claimantAddress: publicJob.claim.claimantAddress,
      status: publicJob.claim.status,
      attempts: publicJob.claim.attempts,
      lastAttemptAt: publicJob.claim.lastAttemptAt,
      lastError: publicJob.claim.lastError,
      nextRetryAt: publicJob.claim.nextRetryAt,
      submittedAt: publicJob.claim.submittedAt,
      txHash: publicJob.claim.txHash,
    },
    error: publicJob.error,
    errorCode: publicJob.errorCode ?? null,
    timeoutPhase: publicJob.timeoutPhase ?? null,
    canRetryProof: publicJob.canRetryProof ?? false,
    proofRetryBlockedReason: publicJob.proofRetryBlockedReason ?? null,
  };
}

export class ProofCoordinatorDO extends DurableObject<WorkerEnv> {
  private timestampMs(value: string | null): number {
    if (!value) {
      return 0;
    }

    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private resolveMaxProofTotalWallTimeMs(): number {
    return parseInteger(
      this.env.MAX_PROOF_TOTAL_WALL_TIME_MS,
      DEFAULT_MAX_PROOF_TOTAL_WALL_TIME_MS,
      60_000,
    );
  }

  private resolveMaxProverRunTimeMs(): number {
    return parseInteger(this.env.MAX_PROVER_RUN_TIME_MS, DEFAULT_MAX_PROVER_RUN_TIME_MS, 60_000);
  }

  private resolveProverPollIntervalMs(): number {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  private resolveCompletedJobRetentionMs(): number {
    return parseInteger(
      this.env.COMPLETED_JOB_RETENTION_MS,
      DEFAULT_COMPLETED_JOB_RETENTION_MS,
      60_000,
    );
  }

  private updateQueueWaitElapsed(job: ProofJobRecord): void {
    const startedAt = this.timestampMs(job.queue.waitStartedAt ?? job.createdAt);
    if (startedAt <= 0) {
      job.queue.waitElapsedMs = null;
      return;
    }
    job.queue.waitElapsedMs = Math.max(0, Date.now() - startedAt);
  }

  private updateRunElapsed(job: ProofJobRecord): void {
    const startedAt = this.timestampMs(job.prover.runStartedAt ?? null);
    if (startedAt <= 0) {
      job.prover.runElapsedMs = null;
      return;
    }
    job.prover.runElapsedMs = Math.max(0, Date.now() - startedAt);
  }

  private clearDispatchLease(job: ProofJobRecord): void {
    job.queue.activeDeliveryId = null;
    job.queue.activeBackend = null;
    job.queue.activeDeliveryStartedAt = null;
  }

  private dispatchLeaseIsStale(job: ProofJobRecord): boolean {
    if (!job.queue.activeDeliveryId || job.prover.jobId) {
      return false;
    }
    const startedAtMs = this.timestampMs(job.queue.activeDeliveryStartedAt ?? null);
    if (startedAtMs <= 0) {
      return true;
    }
    return Date.now() - startedAtMs >= DISPATCH_LEASE_TIMEOUT_MS;
  }

  private latestOpenAttemptIndex<T extends { outcome: "in_progress" | "success" | "failed" }>(
    attempts: T[] | null | undefined,
  ): number | null {
    if (!attempts || attempts.length === 0) {
      return null;
    }
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.outcome === "in_progress") {
        return index;
      }
    }
    return null;
  }

  private normalizeOpenProverAttempts(job: ProofJobRecord): boolean {
    const latestOpenIndex = this.latestOpenAttemptIndex(job.proverAttempts);
    let changed = false;

    for (let index = 0; index < job.proverAttempts.length; index += 1) {
      const attempt = job.proverAttempts[index];
      if (attempt.outcome !== "in_progress" || index === latestOpenIndex) {
        continue;
      }
      attempt.endedAt = attempt.endedAt ?? nowIso();
      attempt.outcome = "failed";
      attempt.error = attempt.error ?? "recovered stale in-progress prover attempt";
      changed = true;
    }

    const nextActiveIndex =
      latestOpenIndex != null && job.proverAttempts[latestOpenIndex]?.outcome === "in_progress"
        ? latestOpenIndex
        : null;
    if ((job.prover.activeAttemptIndex ?? null) !== nextActiveIndex) {
      job.prover.activeAttemptIndex = nextActiveIndex;
      changed = true;
    }

    return changed;
  }

  private normalizeOpenClaimAttempts(job: ProofJobRecord): boolean {
    const latestOpenIndex = this.latestOpenAttemptIndex(job.claimAttempts);
    let changed = false;

    for (let index = 0; index < job.claimAttempts.length; index += 1) {
      const attempt = job.claimAttempts[index];
      if (attempt.outcome !== "in_progress" || index === latestOpenIndex) {
        continue;
      }
      attempt.endedAt = attempt.endedAt ?? nowIso();
      attempt.outcome = "failed";
      attempt.error = attempt.error ?? "recovered stale in-progress claim attempt";
      changed = true;
    }

    const nextActiveIndex =
      latestOpenIndex != null && job.claimAttempts[latestOpenIndex]?.outcome === "in_progress"
        ? latestOpenIndex
        : null;
    if ((job.claim.activeAttemptIndex ?? null) !== nextActiveIndex) {
      job.claim.activeAttemptIndex = nextActiveIndex;
      changed = true;
    }

    return changed;
  }

  private normalizeLoadedJob(job: ProofJobRecord): boolean {
    let changed = false;

    if (job.replayHash === undefined) {
      job.replayHash = null;
      changed = true;
    }
    if (job.replayLockState === undefined) {
      job.replayLockState = null;
      changed = true;
    }
    if (job.replayLockedBackend === undefined) {
      job.replayLockedBackend = null;
      changed = true;
    }
    if (job.canRetryProof === undefined) {
      job.canRetryProof = false;
      changed = true;
    }
    if (job.proofRetryBlockedReason === undefined) {
      job.proofRetryBlockedReason = null;
      changed = true;
    }

    if (job.queue.waitStartedAt == null) {
      job.queue.waitStartedAt = job.createdAt;
      changed = true;
    }
    if (job.queue.waitElapsedMs == null) {
      job.queue.waitElapsedMs = 0;
      changed = true;
    }
    if (job.queue.activeDeliveryId === undefined) {
      job.queue.activeDeliveryId = null;
      changed = true;
    }
    if (job.queue.activeBackend === undefined) {
      job.queue.activeBackend = null;
      changed = true;
    }
    if (job.queue.activeDeliveryStartedAt === undefined) {
      job.queue.activeDeliveryStartedAt = null;
      changed = true;
    }

    if (job.prover.ipfsCid === undefined) {
      job.prover.ipfsCid = null;
      changed = true;
    }
    if (job.prover.runStartedAt === undefined) {
      job.prover.runStartedAt = null;
      changed = true;
    }
    if (job.prover.runElapsedMs === undefined) {
      job.prover.runElapsedMs = null;
      changed = true;
    }
    if (job.prover.activeAttemptIndex === undefined) {
      job.prover.activeAttemptIndex = null;
      changed = true;
    }

    if (job.claim.activeAttemptIndex === undefined) {
      job.claim.activeAttemptIndex = null;
      changed = true;
    }

    if (job.prover.jobId) {
      if (
        job.queue.activeDeliveryId != null ||
        job.queue.activeBackend != null ||
        job.queue.activeDeliveryStartedAt != null
      ) {
        this.clearDispatchLease(job);
        changed = true;
      }
    } else if (this.dispatchLeaseIsStale(job)) {
      this.clearDispatchLease(job);
      changed = true;
    }

    if (this.normalizeOpenProverAttempts(job)) {
      changed = true;
    }
    if (this.normalizeOpenClaimAttempts(job)) {
      changed = true;
    }
    const nextBlockedReason = getProofRetryBlockedReason(job);
    const nextCanRetry = nextBlockedReason === null;
    if (job.proofRetryBlockedReason !== nextBlockedReason) {
      job.proofRetryBlockedReason = nextBlockedReason;
      changed = true;
    }
    if (job.canRetryProof !== nextCanRetry) {
      job.canRetryProof = nextCanRetry;
      changed = true;
    }

    return changed;
  }

  private getActiveProverAttempt(job: ProofJobRecord): ProverAttempt | null {
    const index = job.prover.activeAttemptIndex ?? null;
    if (index != null) {
      const attempt = job.proverAttempts[index];
      if (attempt?.outcome === "in_progress") {
        return attempt;
      }
    }

    const fallbackIndex = this.latestOpenAttemptIndex(job.proverAttempts);
    if (fallbackIndex == null) {
      job.prover.activeAttemptIndex = null;
      return null;
    }

    job.prover.activeAttemptIndex = fallbackIndex;
    return job.proverAttempts[fallbackIndex] ?? null;
  }

  private getActiveClaimAttempt(job: ProofJobRecord): ClaimAttempt | null {
    const index = job.claim.activeAttemptIndex ?? null;
    if (index != null) {
      const attempt = job.claimAttempts[index];
      if (attempt?.outcome === "in_progress") {
        return attempt;
      }
    }

    const fallbackIndex = this.latestOpenAttemptIndex(job.claimAttempts);
    if (fallbackIndex == null) {
      job.claim.activeAttemptIndex = null;
      return null;
    }

    job.claim.activeAttemptIndex = fallbackIndex;
    return job.claimAttempts[fallbackIndex] ?? null;
  }

  private closeActiveClaimAttempt(
    job: ProofJobRecord,
    outcome: "success" | "failed",
    options?: {
      error?: string | null;
      errorDetail?: string | null;
      txHash?: string | null;
    },
  ): boolean {
    const attempt = this.getActiveClaimAttempt(job);
    if (!attempt) {
      return false;
    }

    attempt.endedAt = nowIso();
    attempt.outcome = outcome;
    attempt.error = outcome === "failed" ? (options?.error ?? null) : null;
    attempt.errorDetail = outcome === "failed" ? (options?.errorDetail ?? null) : null;
    attempt.txHash = outcome === "success" ? (options?.txHash ?? null) : null;
    job.claim.activeAttemptIndex = null;
    return true;
  }

  private async unpinIpfsInput(job: ProofJobRecord): Promise<void> {
    const cid = job.prover.ipfsCid;
    if (!cid) {
      return;
    }

    const pinataJwt = this.env.PINATA_JWT;
    if (!pinataJwt) {
      return;
    }

    // Fire-and-forget via waitUntil so it doesn't block the response
    this.ctx.waitUntil(unpinInput(pinataJwt, cid));
  }

  private pruneCompletedJobs(): void {
    this.ensureTable();
    const retentionMs = parseInteger(
      this.env.COMPLETED_JOB_RETENTION_MS,
      DEFAULT_COMPLETED_JOB_RETENTION_MS,
      60_000,
    );
    const cutoffMs = Date.now() - retentionMs;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT job_id, status, completed_at, created_at, data FROM jobs WHERE status IN ('succeeded', 'failed')`,
      )
      .toArray();

    for (const row of rows) {
      const status = row.status as ProofJobRecord["status"];
      const job = JSON.parse(row.data as string) as ProofJobRecord;
      const terminalAndClaimSafe = status === "failed" || job.claim.status === "succeeded";
      if (!terminalAndClaimSafe) {
        continue;
      }

      const completedAtMs = this.timestampMs((row.completed_at as string | null) ?? null);
      const createdAtMs = this.timestampMs((row.created_at as string | null) ?? null);
      const referenceMs = completedAtMs > 0 ? completedAtMs : createdAtMs;
      if (referenceMs <= 0 || referenceMs >= cutoffMs) {
        continue;
      }

      this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE job_id = ?`, row.job_id as string);
    }
  }

  // ── SQLite schema ──────────────────────────────────────────────────

  private tableReady = false;

  private ensureTable(): void {
    if (this.tableReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id           TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        claimant_address TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        completed_at     TEXT,
        data             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_claimant_created
        ON jobs (claimant_address, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_completed
        ON jobs (status, completed_at ASC);
      CREATE TABLE IF NOT EXISTS replay_registry (
        replay_hash        TEXT PRIMARY KEY,
        proof_job_id       TEXT NOT NULL,
        claimant_address   TEXT NOT NULL,
        seed               INTEGER NOT NULL,
        frame_count        INTEGER NOT NULL,
        state              TEXT NOT NULL,
        locked_backend     TEXT,
        first_seen_at      TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        dispatch_started_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_replay_registry_expires
        ON replay_registry (expires_at ASC);
    `);
    this.tableReady = true;
  }

  // ── Storage accessors (SQLite) ────────────────────────────────────

  private getActiveJobIds(): string[] {
    this.ensureTable();
    return this.ctx.storage.sql
      .exec(`SELECT job_id FROM jobs WHERE status NOT IN ('succeeded', 'failed')`)
      .toArray()
      .map((r) => r.job_id as string);
  }

  private async loadJob(jobId: string): Promise<ProofJobRecord | null> {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec(`SELECT data FROM jobs WHERE job_id = ?`, jobId)
      .toArray();
    if (rows.length === 0) {
      return null;
    }

    const job = JSON.parse(rows[0].data as string) as ProofJobRecord;
    if (this.normalizeLoadedJob(job)) {
      await this.saveJob(job);
    }
    return job;
  }

  private async saveJob(job: ProofJobRecord): Promise<void> {
    this.ensureTable();
    withProofRetryEligibility(job);
    const completedAt =
      job.completedAt ??
      (isTerminalProofStatus(job.status) ? (job.updatedAt ?? job.createdAt) : null);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO jobs (job_id, status, claimant_address, created_at, completed_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
      job.jobId,
      job.status,
      job.claim.claimantAddress,
      job.createdAt,
      completedAt,
      JSON.stringify(job),
    );
  }

  private replayExpiryIso(fromMs = Date.now()): string {
    return new Date(fromMs + REPLAY_DEDUPE_WINDOW_MS).toISOString();
  }

  private purgeExpiredReplayRegistry(): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `DELETE FROM replay_registry WHERE expires_at <= ?`,
      new Date().toISOString(),
    );
  }

  private loadReplayRegistryRow(replayHash: string): ReplayRegistryRow | null {
    this.ensureTable();
    this.purgeExpiredReplayRegistry();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT replay_hash, proof_job_id, claimant_address, seed, frame_count, state,
                locked_backend, first_seen_at, expires_at, dispatch_started_at
         FROM replay_registry WHERE replay_hash = ?`,
        replayHash,
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      replay_hash: row.replay_hash as string,
      proof_job_id: row.proof_job_id as string,
      claimant_address: row.claimant_address as string,
      seed: Number(row.seed),
      frame_count: Number(row.frame_count),
      state: row.state as ReplayRegistryState,
      locked_backend:
        row.locked_backend === "boundless" || row.locked_backend === "vast"
          ? (row.locked_backend as ProverBackend)
          : null,
      first_seen_at: row.first_seen_at as string,
      expires_at: row.expires_at as string,
      dispatch_started_at: (row.dispatch_started_at as string | null) ?? null,
    };
  }

  private upsertReplayRegistry(row: ReplayRegistryRow): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO replay_registry (
         replay_hash, proof_job_id, claimant_address, seed, frame_count, state,
         locked_backend, first_seen_at, expires_at, dispatch_started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.replay_hash,
      row.proof_job_id,
      row.claimant_address,
      row.seed,
      row.frame_count,
      row.state,
      row.locked_backend,
      row.first_seen_at,
      row.expires_at,
      row.dispatch_started_at,
    );
  }

  private deleteReplayRegistry(replayHash: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(`DELETE FROM replay_registry WHERE replay_hash = ?`, replayHash);
  }

  private async releaseReplayReservation(job: ProofJobRecord): Promise<boolean> {
    if (
      !job.replayHash ||
      job.replayLockState === "dispatching" ||
      job.replayLockState === "dispatched"
    ) {
      return false;
    }

    this.deleteReplayRegistry(job.replayHash);
    job.replayLockState = "released";
    job.replayLockedBackend = null;
    await this.saveJob(job);
    return true;
  }

  private async reserveReplayForJob(job: ProofJobRecord): Promise<void> {
    if (!job.replayHash) {
      return;
    }

    const existing = this.loadReplayRegistryRow(job.replayHash);
    if (existing && existing.proof_job_id !== job.jobId) {
      throw new Error("replay hash is already reserved by a different job");
    }

    this.upsertReplayRegistry({
      replay_hash: job.replayHash,
      proof_job_id: job.jobId,
      claimant_address: job.claim.claimantAddress,
      seed: job.tape.metadata.seed >>> 0,
      frame_count: job.tape.metadata.frameCount >>> 0,
      state: "reserved",
      locked_backend: null,
      first_seen_at: existing?.first_seen_at ?? job.createdAt,
      expires_at: this.replayExpiryIso(),
      dispatch_started_at: null,
    });
    job.replayLockState = "reserved";
    job.replayLockedBackend = null;
    await this.saveJob(job);
  }

  private replayDispatchLocked(job: ProofJobRecord): boolean {
    return job.replayLockState === "dispatching" || job.replayLockState === "dispatched";
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * If there are no active or retained jobs left, clear all DO storage so the
   * object can be fully deallocated.
   */
  private async flushStorageIfEmpty(): Promise<boolean> {
    const activeJobIds = this.getActiveJobIds();
    if (activeJobIds.length > 0) {
      return false;
    }

    this.ensureTable();
    this.purgeExpiredReplayRegistry();
    const remaining = this.ctx.storage.sql.exec(`SELECT 1 FROM jobs LIMIT 1`).toArray();
    const replayRemaining = this.ctx.storage.sql
      .exec(`SELECT 1 FROM replay_registry LIMIT 1`)
      .toArray();
    if (remaining.length > 0 || replayRemaining.length > 0) {
      return false;
    }

    await this.ctx.storage.deleteAll();
    this.tableReady = false;
    return true;
  }

  private isBoundlessJob(job: ProofJobRecord): boolean {
    return job.prover.statusUrl?.startsWith("boundless:") === true;
  }

  private getLatestSuccessfulAttempt(job: ProofJobRecord): ProverAttempt | null {
    for (let i = job.proverAttempts.length - 1; i >= 0; i -= 1) {
      const attempt = job.proverAttempts[i];
      if (attempt.outcome === "success") {
        return attempt;
      }
    }
    return null;
  }

  private isBoundlessSuccessAttempt(job: ProofJobRecord, attempt: ProverAttempt): boolean {
    return (
      attempt.backend === "boundless" ||
      attempt.statusUrl?.startsWith("boundless:") === true ||
      this.isBoundlessJob(job)
    );
  }

  private normalizeBoundlessRequestId(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const normalized = trimmed.startsWith("boundless:")
      ? trimmed.slice("boundless:".length)
      : trimmed;
    if (/^0x[0-9a-f]+$/i.test(normalized)) return normalized;
    return null;
  }

  private isRecoverableTimedOutBoundlessJob(job: ProofJobRecord): boolean {
    return (
      job.status === "failed" &&
      job.errorCode === "job_total_wall_timeout" &&
      job.timeoutPhase === "total_wall" &&
      !job.result &&
      job.claim.status !== "succeeded" &&
      this.isBoundlessJob(job) &&
      job.prover.jobId != null &&
      (job.replayLockState === "dispatching" || job.replayLockState === "dispatched")
    );
  }

  private async repairRecoveredBoundlessAttempt(
    jobId: string,
    enrichment?: {
      actualCostUsd?: number | null;
      proverAddress?: string | null;
      fulfillmentTxHash?: string | null;
      programCycles?: number | null;
      totalCycles?: number | null;
    },
  ): Promise<void> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return;
    }

    const latestAttempt = [...job.proverAttempts]
      .reverse()
      .find(
        (attempt) =>
          attempt.backend === "boundless" &&
          attempt.proverJobId === job.prover.jobId &&
          attempt.outcome === "failed",
      );
    if (!latestAttempt) {
      return;
    }

    latestAttempt.outcome = "success";
    latestAttempt.error = null;
    latestAttempt.errorDetail = null;
    latestAttempt.errorCode = null;
    if (enrichment) {
      if (enrichment.actualCostUsd !== undefined) latestAttempt.actualCostUsd = enrichment.actualCostUsd;
      if (enrichment.proverAddress !== undefined) latestAttempt.proverAddress = enrichment.proverAddress;
      if (enrichment.fulfillmentTxHash !== undefined)
        latestAttempt.fulfillmentTxHash = enrichment.fulfillmentTxHash;
      if (enrichment.programCycles !== undefined) latestAttempt.programCycles = enrichment.programCycles;
      if (enrichment.totalCycles !== undefined) latestAttempt.totalCycles = enrichment.totalCycles;
    }

    await this.saveJob(job);
  }

  private async recoverBoundlessFulfillment(
    jobId: string,
    job: ProofJobRecord,
  ): Promise<ProofJobRecord | null> {
    if (!this.isRecoverableTimedOutBoundlessJob(job)) {
      return job;
    }

    const boundlessConfig = resolveBoundlessConfig(this.env);
    if (!boundlessConfig || !job.prover.jobId) {
      return job;
    }

    let pollResult: ProverPollResult;
    try {
      pollResult = await new BoundlessClient(boundlessConfig).pollOnce(job.prover.jobId);
    } catch {
      return job;
    }

    if (pollResult.type !== "success") {
      return job;
    }

    await this.repairRecoveredBoundlessAttempt(jobId, pollResult.metadata);

    const artifactStorageKey = resultKey(jobId);
    try {
      await this.env.PROOF_ARTIFACTS.put(
        artifactStorageKey,
        JSON.stringify(pollResult.artifact, null, 2),
        {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { jobId },
        },
      );
    } catch (error) {
      console.warn(
        `[coordinator] failed writing recovered boundless artifact for ${jobId}: ${safeErrorMessage(error)}`,
      );
      return await this.loadJob(jobId);
    }

    await this.markSucceeded(jobId, pollResult.summary, artifactStorageKey, pollResult.metadata);
    return await this.loadJob(jobId);
  }

  private async maybeRecoverTimedOutBoundlessJob(
    jobId: string,
    job: ProofJobRecord,
  ): Promise<ProofJobRecord | null> {
    if (!this.isRecoverableTimedOutBoundlessJob(job)) {
      return job;
    }

    return this.recoverBoundlessFulfillment(jobId, job);
  }

  private getBoundlessRequestId(job: ProofJobRecord, attempt: ProverAttempt): string | null {
    const candidates = [
      attempt.proverJobId,
      attempt.statusUrl,
      job.prover.jobId,
      job.prover.statusUrl,
    ];

    for (const candidate of candidates) {
      const requestId = this.normalizeBoundlessRequestId(candidate);
      if (requestId) return requestId;
    }
    return null;
  }

  private getBoundlessChainId(): string {
    const raw = this.env.BOUNDLESS_CHAIN_ID?.trim();
    if (!raw) return DEFAULT_BOUNDLESS_CHAIN_ID;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BOUNDLESS_CHAIN_ID;
    return String(parsed);
  }

  private normalizeCycleMetric(value: number | null | undefined): number | null {
    if (value == null || !Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.floor(value));
  }

  private syncResultCycleStats(
    job: ProofJobRecord,
    programCycles: number | null | undefined,
    totalCycles: number | null | undefined,
  ): boolean {
    const stats = job.result?.summary?.stats;
    if (!stats) {
      return false;
    }

    const normalizedTotal = this.normalizeCycleMetric(totalCycles);
    if (normalizedTotal == null || normalizedTotal <= 0) {
      return false;
    }

    let changed = false;
    if (stats.total_cycles !== normalizedTotal) {
      stats.total_cycles = normalizedTotal;
      changed = true;
    }

    const normalizedProgram = this.normalizeCycleMetric(programCycles);
    if (normalizedProgram != null && stats.user_cycles !== normalizedProgram) {
      stats.user_cycles = normalizedProgram;
      changed = true;
    }

    return changed;
  }

  async createJob(
    tapeInfo: Omit<ProofTapeInfo, "key"> & { claimantAddress: string; replayHash: string },
  ): Promise<CreateJobAccepted> {
    const { claimantAddress, replayHash, ...proofTape } = tapeInfo;
    const existing = this.loadReplayRegistryRow(replayHash);
    if (existing) {
      const existingJob = await this.loadJob(existing.proof_job_id);
      if (existingJob) {
        return {
          accepted: true,
          duplicate: true,
          replayHash,
          job: existingJob,
        };
      }
      if (replayRowIsPermanentlyLocked(existing)) {
        throw new Error("replay has already entered external dispatch and cannot be submitted again");
      }
      this.deleteReplayRegistry(replayHash);
    }

    const jobId = crypto.randomUUID();
    const now = nowIso();

    const job: ProofJobRecord = {
      jobId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      replayHash,
      replayLockState: "reserved",
      replayLockedBackend: null,
      tape: {
        ...proofTape,
        key: tapeKey(jobId),
      },
      queue: {
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        waitStartedAt: now,
        waitElapsedMs: 0,
        activeDeliveryId: null,
        activeBackend: null,
        activeDeliveryStartedAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
        runStartedAt: null,
        runElapsedMs: null,
        activeAttemptIndex: null,
      },
      proverAttempts: [],
      claimAttempts: [],
      result: null,
      claim: {
        claimantAddress,
        status: "queued",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
        activeAttemptIndex: null,
      },
      error: null,
      errorCode: null,
      timeoutPhase: null,
    };

    await this.saveJob(job);
    this.upsertReplayRegistry({
      replay_hash: replayHash,
      proof_job_id: jobId,
      claimant_address: claimantAddress,
      seed: proofTape.metadata.seed >>> 0,
      frame_count: proofTape.metadata.frameCount >>> 0,
      state: "reserved",
      locked_backend: null,
      first_seen_at: now,
      expires_at: this.replayExpiryIso(),
      dispatch_started_at: null,
    });

    return {
      accepted: true,
      duplicate: false,
      replayHash,
      job,
    };
  }

  async getJob(jobId: string): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }

    return (await this.maybeRecoverTimedOutBoundlessJob(jobId, job)) ?? job;
  }

  /**
   * Lightweight periodic maintenance:
   * - keep the alarm chain alive while active jobs exist
   * - prune completed jobs by time-based retention policy
   * - auto-recover unfinished claims that got stuck in queued/retrying/submitting/failed states
   * - fully clear storage when the coordinator is empty
   */
  async runMaintenance(): Promise<{
    alarmsRescheduled: number;
    claimsRequeued: number;
    staleQueuedClaimsRequeued: number;
    staleRetryingClaimsRequeued: number;
    staleSubmittingClaimsRecovered: number;
    boundlessFulfillmentRecoveries: number;
  }> {
    const activeJobIds = this.getActiveJobIds();
    let alarmsRescheduled = 0;
    if (activeJobIds.length > 0) {
      // Keep the alarm chain alive even if no reads/queue activity happen.
      // This avoids request-path watchdog logic and keeps progress cron/alarm-driven.
      const currentAlarm = await this.ctx.storage.getAlarm();
      const alarmMissing = currentAlarm == null || currentAlarm < Date.now();
      if (alarmMissing) {
        const pollIntervalMs = this.resolveProverPollIntervalMs();
        await this.scheduleAlarm(pollIntervalMs);
        alarmsRescheduled += 1;
      }
    }

    let claimRecovery = {
      claimsRequeued: 0,
      staleQueuedClaimsRequeued: 0,
      staleRetryingClaimsRequeued: 0,
      staleSubmittingClaimsRecovered: 0,
    };
    let boundlessFulfillmentRecoveries = 0;

    // Auto-recover claims that got stuck after queue or relayer failures. This
    // recovers from transient issues that outlast the queue retry window
    // without requiring manual intervention.
    try {
      claimRecovery = await this.autoRecoverUnfinishedClaims();
    } catch (error) {
      console.warn(`[maintenance] autoRecoverUnfinishedClaims error: ${safeErrorMessage(error)}`);
    }

    try {
      boundlessFulfillmentRecoveries = await this.autoRecoverTimedOutBoundlessJobs();
    } catch (error) {
      console.warn(
        `[maintenance] autoRecoverTimedOutBoundlessJobs error: ${safeErrorMessage(error)}`,
      );
    }

    if (activeJobIds.length === 0) {
      await this.pruneCompletedJobs();
      await this.flushStorageIfEmpty();
    }

    return {
      alarmsRescheduled,
      ...claimRecovery,
      boundlessFulfillmentRecoveries,
    };
  }

  /**
   * Lazy backfill: if a succeeded Boundless job has null cycle counts,
   * re-check the indexer (Bento processes cycles asynchronously) and
   * persist the result so subsequent reads are free.
   *
   * Returns the (possibly enriched) job record, or null if not found.
   */
  async enrichBoundlessCycles(jobId: string): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) return null;

    // Only enrich succeeded Boundless jobs
    if (job.status !== "succeeded") return job;
    const attempt = this.getLatestSuccessfulAttempt(job);
    if (!attempt) return job;
    if (!this.isBoundlessSuccessAttempt(job, attempt)) return job;

    const hasAttemptCycles = attempt.totalCycles != null;
    const summaryTotal = job.result?.summary?.stats.total_cycles ?? null;
    const summaryMissingCycles =
      summaryTotal == null || !Number.isFinite(summaryTotal) || summaryTotal <= 0;

    if (!summaryMissingCycles && !hasAttemptCycles) {
      return job;
    }

    // Fast path: cycles already exist on the attempt but canonical summary stats
    // are missing. Persist canonical stats on read.
    if (hasAttemptCycles && summaryMissingCycles) {
      if (this.syncResultCycleStats(job, attempt.programCycles, attempt.totalCycles)) {
        await this.saveJob(job);
      }
      return job;
    }

    // Nothing missing to enrich.
    if (hasAttemptCycles) {
      return job;
    }

    const requestIdHex = this.getBoundlessRequestId(job, attempt);
    if (!requestIdHex) return job;

    try {
      const chainId = this.getBoundlessChainId();
      const { programCycles, totalCycles } = await fetchBoundlessCycles(chainId, requestIdHex);
      if (totalCycles != null) {
        let changed = false;
        if (attempt.programCycles !== programCycles) {
          attempt.programCycles = programCycles;
          changed = true;
        }
        if (attempt.totalCycles !== totalCycles) {
          attempt.totalCycles = totalCycles;
          changed = true;
        }
        if (this.syncResultCycleStats(job, programCycles, totalCycles)) {
          changed = true;
        }
        if (changed) {
          await this.saveJob(job);
        }
      }
    } catch (error) {
      // Non-fatal — indexer may be down; next read will retry.
      console.warn(
        `[coordinator] cycle backfill failed for ${jobId} (${requestIdHex}): ${safeErrorMessage(error)}`,
      );
    }
    return job;
  }

  async getActiveJobsSummary(): Promise<{
    total: number;
    boundless: number;
    vast: number;
    waitingDispatch: number;
    oldestActiveAgeSec: number | null;
    oldestWaitingDispatchAgeSec: number | null;
    statusCounts: {
      queued: number;
      dispatching: number;
      proverRunning: number;
      retrying: number;
    };
    firstJobId: string | null;
  }> {
    const activeJobIds = this.getActiveJobIds();
    let total = 0;
    let boundless = 0;
    let vast = 0;
    let waitingDispatch = 0;
    let oldestActiveCreatedAtMs: number | null = null;
    let oldestWaitingDispatchCreatedAtMs: number | null = null;
    const statusCounts = {
      queued: 0,
      dispatching: 0,
      proverRunning: 0,
      retrying: 0,
    };
    let firstJobId: string | null = null;

    for (const jobId of activeJobIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential DO storage reads
      const job = await this.loadJob(jobId);
      if (!job || isTerminalProofStatus(job.status)) {
        continue;
      }

      if (firstJobId == null) {
        firstJobId = jobId;
      }
      total += 1;
      const createdAtMs = this.timestampMs(job.createdAt);
      if (createdAtMs > 0) {
        oldestActiveCreatedAtMs =
          oldestActiveCreatedAtMs == null
            ? createdAtMs
            : Math.min(oldestActiveCreatedAtMs, createdAtMs);
      }
      if (job.status === "queued") statusCounts.queued += 1;
      if (job.status === "dispatching") statusCounts.dispatching += 1;
      if (job.status === "prover_running") statusCounts.proverRunning += 1;
      if (job.status === "retrying") statusCounts.retrying += 1;

      if (!job.prover.jobId) {
        waitingDispatch += 1;
        if (createdAtMs > 0) {
          oldestWaitingDispatchCreatedAtMs =
            oldestWaitingDispatchCreatedAtMs == null
              ? createdAtMs
              : Math.min(oldestWaitingDispatchCreatedAtMs, createdAtMs);
        }
        continue;
      }

      if (this.isBoundlessJob(job)) {
        boundless += 1;
      } else {
        vast += 1;
      }
    }

    return {
      total,
      boundless,
      vast,
      waitingDispatch,
      oldestActiveAgeSec:
        oldestActiveCreatedAtMs == null
          ? null
          : Math.max(0, Math.floor((Date.now() - oldestActiveCreatedAtMs) / 1000)),
      oldestWaitingDispatchAgeSec:
        oldestWaitingDispatchCreatedAtMs == null
          ? null
          : Math.max(0, Math.floor((Date.now() - oldestWaitingDispatchCreatedAtMs) / 1000)),
      statusCounts,
      firstJobId,
    };
  }

  async getActiveJob(): Promise<ProofJobRecord | null> {
    const activeJobIds = this.getActiveJobIds();
    for (const jobId of activeJobIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential DO storage reads
      const job = await this.loadJob(jobId);
      if (job && !isTerminalProofStatus(job.status)) {
        return job;
      }
    }
    return null;
  }

  /**
   * Returns true if a VastAI prover job is currently running (submitted and
   * being polled). Used by the VastAI queue consumer to enforce 1-at-a-time.
   */
  async hasActiveVastJob(): Promise<boolean> {
    return (await this.getActiveVastJob()) !== null;
  }

  async getActiveVastJob(): Promise<ProofJobRecord | null> {
    const activeJobIds = this.getActiveJobIds();
    for (const jobId of activeJobIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential DO storage reads
      const job = await this.loadJob(jobId);
      if (
        job &&
        !isTerminalProofStatus(job.status) &&
        job.prover.jobId &&
        !this.isBoundlessJob(job)
      ) {
        return job;
      }
    }
    return null;
  }

  async listSucceededJobs(): Promise<ProofJobRecord[]> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT data FROM jobs WHERE status = 'succeeded'`)
      .toArray();
    const jobs: ProofJobRecord[] = [];
    for (const row of rows) {
      const job = JSON.parse(row.data as string) as ProofJobRecord;
      if (job.result?.summary) {
        jobs.push(job);
      }
    }
    return jobs;
  }

  async beginQueueAttempt(
    jobId: string,
    attempts: number,
    backend: ProverBackend,
    deliveryId: string,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }

    const now = nowIso();
    job.queue.attempts = Math.max(job.queue.attempts, attempts);
    if (job.prover.jobId) {
      job.status = "prover_running";
      job.updatedAt = now;
      job.queue.lastAttemptAt = now;
      job.queue.nextRetryAt = null;
      this.clearDispatchLease(job);
      this.updateQueueWaitElapsed(job);
      this.updateRunElapsed(job);
      await this.saveJob(job);

      const pollIntervalMs = this.resolveProverPollIntervalMs();
      await this.scheduleAlarm(pollIntervalMs);
      return job;
    }

    if (this.dispatchLeaseIsStale(job)) {
      this.clearDispatchLease(job);
    }

    if (job.queue.activeDeliveryId && job.queue.activeDeliveryId !== deliveryId) {
      await this.saveJob(job);
      return job;
    }

    job.status = "dispatching";
    job.updatedAt = now;
    job.queue.lastAttemptAt = now;
    job.queue.nextRetryAt = null;
    job.queue.activeDeliveryId = deliveryId;
    job.queue.activeBackend = backend;
    job.queue.activeDeliveryStartedAt = now;
    if (!job.queue.waitStartedAt) {
      job.queue.waitStartedAt = job.createdAt;
    }
    this.updateQueueWaitElapsed(job);
    this.updateRunElapsed(job);
    await this.saveJob(job);

    return job;
  }

  async beginExternalDispatch(
    jobId: string,
    backend: ProverBackend,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }
    if (!job.replayHash) {
      return job;
    }
    if (job.replayLockState === "dispatched") {
      throw new Error("replay is already locked after external dispatch");
    }
    if (job.replayLockState === "dispatching" && job.replayLockedBackend !== backend) {
      throw new Error("replay is already dispatching to a different backend");
    }

    const existing = this.loadReplayRegistryRow(job.replayHash);
    if (existing && existing.proof_job_id !== job.jobId) {
      throw new Error("replay hash is already reserved by a different job");
    }
    if (!existing) {
      await this.reserveReplayForJob(job);
    }

    const now = nowIso();
    job.replayLockState = "dispatching";
    job.replayLockedBackend = backend;
    job.updatedAt = now;
    await this.saveJob(job);
    this.upsertReplayRegistry({
      replay_hash: job.replayHash,
      proof_job_id: job.jobId,
      claimant_address: job.claim.claimantAddress,
      seed: job.tape.metadata.seed >>> 0,
      frame_count: job.tape.metadata.frameCount >>> 0,
      state: "dispatching",
      locked_backend: backend,
      first_seen_at: existing?.first_seen_at ?? job.createdAt,
      expires_at: PERMANENT_REPLAY_LOCK_EXPIRES_AT,
      dispatch_started_at: now,
    });

    return job;
  }

  async markRetry(
    jobId: string,
    reason: string,
    nextRetryAt: string,
    clearProverJob?: boolean,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }

    job.status = "retrying";
    job.updatedAt = nowIso();
    job.queue.lastError = reason;
    job.queue.nextRetryAt = nextRetryAt;
    this.clearDispatchLease(job);
    this.updateQueueWaitElapsed(job);
    this.updateRunElapsed(job);
    if (clearProverJob) {
      job.prover.jobId = null;
      job.prover.status = null;
      job.prover.statusUrl = null;
      job.prover.segmentLimitPo2 = null;
      job.prover.lastPolledAt = null;
      job.prover.pollingErrors = 0;
      job.prover.runStartedAt = null;
      job.prover.runElapsedMs = null;
    }
    await this.saveJob(job);
    return job;
  }

  async markProverAccepted(
    jobId: string,
    proverJobId: string,
    statusUrl: string,
    segmentLimitPo2: number,
    ipfsCid?: string,
    maxPriceUsd?: number,
    minPriceWei?: string,
    maxPriceWei?: string,
    fundingModeUsed?: ProverAttempt["fundingModeUsed"],
    marketBalanceBeforeWei?: string,
    autoDepositWei?: string,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }

    job.status = "prover_running";
    job.updatedAt = nowIso();
    job.queue.lastError = null;
    job.queue.nextRetryAt = null;
    this.clearDispatchLease(job);
    this.updateQueueWaitElapsed(job);
    job.prover.jobId = proverJobId;
    job.prover.status = "queued";
    job.prover.statusUrl = statusUrl;
    job.prover.segmentLimitPo2 = segmentLimitPo2;
    job.prover.pollingErrors = 0;
    job.prover.runStartedAt = nowIso();
    job.prover.runElapsedMs = 0;
    job.errorCode = null;
    job.timeoutPhase = null;
    if (job.replayHash) {
      job.replayLockState = "dispatched";
    }
    if (ipfsCid) {
      job.prover.ipfsCid = ipfsCid;
    }
    await this.saveJob(job);
    if (job.replayHash) {
      const existing = this.loadReplayRegistryRow(job.replayHash);
      this.upsertReplayRegistry({
        replay_hash: job.replayHash,
        proof_job_id: job.jobId,
        claimant_address: job.claim.claimantAddress,
        seed: job.tape.metadata.seed >>> 0,
        frame_count: job.tape.metadata.frameCount >>> 0,
        state: "dispatched",
        locked_backend:
          job.replayLockedBackend ?? (statusUrl.startsWith("boundless:") ? "boundless" : "vast"),
        first_seen_at: existing?.first_seen_at ?? job.createdAt,
        expires_at: PERMANENT_REPLAY_LOCK_EXPIRES_AT,
        dispatch_started_at: existing?.dispatch_started_at ?? nowIso(),
      });
    }

    const currentAttempt = this.getActiveProverAttempt(job);
    if (
      currentAttempt &&
      currentAttempt.proverJobId === proverJobId &&
      currentAttempt.statusUrl === statusUrl
    ) {
      currentAttempt.maxPriceUsd = maxPriceUsd ?? currentAttempt.maxPriceUsd ?? null;
      currentAttempt.minPriceWei = minPriceWei ?? currentAttempt.minPriceWei ?? null;
      currentAttempt.maxPriceWei = maxPriceWei ?? currentAttempt.maxPriceWei ?? null;
      currentAttempt.fundingModeUsed = fundingModeUsed ?? currentAttempt.fundingModeUsed ?? null;
      currentAttempt.marketBalanceBeforeWei =
        marketBalanceBeforeWei ?? currentAttempt.marketBalanceBeforeWei ?? null;
      currentAttempt.autoDepositWei = autoDepositWei ?? currentAttempt.autoDepositWei ?? null;
      await this.saveJob(job);
    } else {
      const backend: ProverBackend = statusUrl.startsWith("boundless:") ? "boundless" : "vast";
      const attemptIndex = job.proverAttempts.length;
      const attempt: ProverAttempt = {
        index: attemptIndex,
        backend,
        startedAt: nowIso(),
        endedAt: null,
        outcome: "in_progress",
        error: null,
        errorDetail: null,
        errorCode: null,
        proverJobId,
        statusUrl,
        maxPriceUsd: maxPriceUsd ?? null,
        minPriceWei: minPriceWei ?? null,
        maxPriceWei: maxPriceWei ?? null,
        fundingModeUsed: fundingModeUsed ?? null,
        marketBalanceBeforeWei: marketBalanceBeforeWei ?? null,
        autoDepositWei: autoDepositWei ?? null,
        actualCostUsd: null,
        proverAddress: null,
        fulfillmentTxHash: null,
        programCycles: null,
        totalCycles: null,
      };
      job.proverAttempts.push(attempt);
      job.prover.activeAttemptIndex = attemptIndex;
      await this.saveJob(job);
    }

    const pollIntervalMs = this.resolveProverPollIntervalMs();
    await this.scheduleAlarm(pollIntervalMs);

    return job;
  }

  async markSucceeded(
    jobId: string,
    summary: ProofResultSummary,
    artifactKey: string,
    enrichment?: {
      actualCostUsd?: number | null;
      proverAddress?: string | null;
      fulfillmentTxHash?: string | null;
      programCycles?: number | null;
      totalCycles?: number | null;
    },
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }

    let requestedClaimant = "";
    let provedClaimant = "";
    try {
      requestedClaimant = parseClaimantStrKeyFromUserInput(job.claim.claimantAddress).normalized;
      provedClaimant = parseClaimantStrKeyFromUserInput(summary.journal.claimant).normalized;
    } catch {
      return this.markFailed(jobId, "prover returned invalid claimant in journal");
    }
    if (requestedClaimant !== provedClaimant) {
      return this.markFailed(
        jobId,
        `prover journal claimant mismatch: requested ${requestedClaimant}, proved ${provedClaimant}`,
      );
    }

    const now = nowIso();
    job.status = "succeeded";
    job.updatedAt = now;
    job.completedAt = now;
    job.queue.lastError = null;
    job.queue.nextRetryAt = null;
    this.clearDispatchLease(job);
    job.prover.status = "succeeded";
    job.prover.lastPolledAt = now;
    this.updateRunElapsed(job);
    job.result = {
      artifactKey,
      summary,
    };
    // Keep canonicalized claimant in state after proof confirmation.
    job.claim.claimantAddress = provedClaimant;
    job.error = null;
    job.claim.status = "queued";
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.claim.activeAttemptIndex = null;
    job.errorCode = null;
    job.timeoutPhase = null;

    await this.saveJob(job);
    await this.recordAttemptEnd(job, "success", null, enrichment);
    await this.unpinIpfsInput(job);
    await this.enqueueClaimJob(jobId);
    try {
      this.pruneCompletedJobs();
      await this.flushStorageIfEmpty();
    } catch (error) {
      console.warn(`[proof-worker] prune after success failed: ${safeErrorMessage(error)}`);
    }
    return job;
  }

  async markFailed(
    jobId: string,
    reason: string,
    enrichment?: {
      errorDetail?: string | null;
      errorCode?: string | null;
      timeoutPhase?: ProofTimeoutPhase | null;
    },
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }

    // Close any lingering in-progress attempt so the UI shows it as failed
    const openAttempt = this.getActiveProverAttempt(job);
    if (openAttempt) {
      openAttempt.endedAt = nowIso();
      openAttempt.outcome = "failed";
      openAttempt.error = openAttempt.error ?? reason;
      if (enrichment) {
        if (enrichment.errorDetail !== undefined) openAttempt.errorDetail = enrichment.errorDetail;
        if (enrichment.errorCode !== undefined) openAttempt.errorCode = enrichment.errorCode;
      }
      job.prover.activeAttemptIndex = null;
    }

    const now = nowIso();
    job.status = "failed";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = reason;
    job.errorCode = enrichment?.errorCode ?? null;
    job.timeoutPhase = enrichment?.timeoutPhase ?? null;
    job.queue.lastError = reason;
    job.queue.nextRetryAt = null;
    this.clearDispatchLease(job);
    this.updateQueueWaitElapsed(job);
    this.updateRunElapsed(job);
    if (job.prover.status !== "succeeded") {
      job.prover.status = "failed";
      job.prover.lastPolledAt = now;
    }
    if (job.claim.status !== "succeeded") {
      job.claim.status = "failed";
      job.claim.lastError = `proof failed before on-chain claim: ${reason}`;
      job.claim.nextRetryAt = null;
      job.claim.activeAttemptIndex = null;
    }

    await this.saveJob(job);
    await this.releaseReplayReservation(job);
    await this.unpinIpfsInput(job);
    try {
      this.pruneCompletedJobs();
      await this.flushStorageIfEmpty();
    } catch (error) {
      console.warn(`[proof-worker] prune after failure failed: ${safeErrorMessage(error)}`);
    }
    return job;
  }

  private async enqueueClaimJob(jobId: string): Promise<void> {
    const job = await this.loadJob(jobId);
    if (!job || !job.result) {
      return;
    }
    if (job.claim.status === "succeeded") {
      return;
    }

    try {
      await this.env.CLAIM_QUEUE.send(
        { jobId },
        {
          contentType: "json",
        },
      );
      job.claim.status = "queued";
      job.claim.nextRetryAt = null;
      await this.saveJob(job);
    } catch (error) {
      job.claim.status = "failed";
      job.claim.lastError = `failed enqueueing claim job: ${safeErrorMessage(error)}`;
      job.claim.nextRetryAt = null;
      await this.saveJob(job);
    }
  }

  async beginClaimAttempt(jobId: string, attempts: number): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || job.status !== "succeeded") {
      return job;
    }
    if (job.claim.status === "succeeded") {
      return job;
    }
    if (!job.result?.summary) {
      return job;
    }

    const existingAttempt = this.getActiveClaimAttempt(job);
    job.claim.status = "submitting";
    job.claim.attempts = Math.max(job.claim.attempts, attempts);
    if (!existingAttempt) {
      job.claim.lastAttemptAt = nowIso();
    }
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();

    if (!existingAttempt) {
      const claimAttempts = job.claimAttempts ?? [];
      const attemptIndex = claimAttempts.length;
      const attempt: ClaimAttempt = {
        index: attemptIndex,
        startedAt: nowIso(),
        endedAt: null,
        outcome: "in_progress",
        error: null,
        errorDetail: null,
        txHash: null,
      };
      claimAttempts.push(attempt);
      job.claimAttempts = claimAttempts;
      job.claim.activeAttemptIndex = attemptIndex;
    }

    await this.saveJob(job);
    return job;
  }

  private async autoRecoverTimedOutBoundlessJobs(): Promise<number> {
    this.ensureTable();
    const retentionCutoff = new Date(
      Date.now() - this.resolveCompletedJobRetentionMs(),
    ).toISOString();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT job_id, data
         FROM jobs
         WHERE status = 'failed' AND completed_at >= ?
         ORDER BY completed_at DESC
         LIMIT 25`,
        retentionCutoff,
      )
      .toArray();

    let recovered = 0;
    for (const row of rows) {
      const jobId = row.job_id as string;
      const job = JSON.parse(row.data as string) as ProofJobRecord;
      const repaired = await this.maybeRecoverTimedOutBoundlessJob(jobId, job);
      if (repaired && repaired.status === "succeeded") {
        recovered += 1;
      }
    }

    return recovered;
  }

  async markClaimRetry(
    jobId: string,
    reason: string,
    nextRetryAt: string,
    errorDetail?: string,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || job.status !== "succeeded") {
      return job;
    }
    if (job.claim.status === "succeeded") {
      return job;
    }

    job.claim.status = "retrying";
    job.claim.lastError = reason;
    job.claim.nextRetryAt = nextRetryAt;
    job.updatedAt = nowIso();
    this.closeActiveClaimAttempt(job, "failed", {
      error: reason,
      errorDetail: errorDetail ?? null,
    });

    await this.saveJob(job);
    return job;
  }

  async markClaimSucceeded(jobId: string, txHash: string): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || job.status !== "succeeded") {
      return job;
    }
    if (job.claim.status === "succeeded") {
      return job;
    }

    job.claim.status = "succeeded";
    job.claim.submittedAt = nowIso();
    job.claim.txHash = txHash;
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();
    this.closeActiveClaimAttempt(job, "success", { txHash });

    await this.saveJob(job);
    return job;
  }

  async markClaimFailed(
    jobId: string,
    reason: string,
    errorDetail?: string,
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || job.status !== "succeeded") {
      return job;
    }
    if (job.claim.status === "succeeded") {
      return job;
    }

    // If a prior attempt already recorded a txHash the transaction landed
    // on-chain. Promote to succeeded rather than marking failed.
    if (job.claim.txHash) {
      console.log("[coordinator] claim has txHash — promoting to succeeded instead of failed", {
        jobId,
        txHash: job.claim.txHash,
        reason,
      });
      job.claim.status = "succeeded";
      job.claim.lastError = null;
      job.claim.nextRetryAt = null;
      job.updatedAt = nowIso();
      this.closeActiveClaimAttempt(job, "success", { txHash: job.claim.txHash });

      await this.saveJob(job);
      return job;
    }

    job.claim.status = "failed";
    job.claim.lastError = reason;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();
    this.closeActiveClaimAttempt(job, "failed", {
      error: reason,
      errorDetail: errorDetail ?? null,
    });

    await this.saveJob(job);
    return job;
  }

  /**
   * Re-queues a claim that previously failed. Only allowed when the proof
   * succeeded but the on-chain claim exhausted its retries.
   */
  async retryFailedClaim(jobId: string): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }
    if (job.status !== "succeeded") {
      throw new Error("cannot retry claim: proof has not succeeded");
    }
    if (job.claim.status === "succeeded") {
      throw new Error("claim already succeeded");
    }
    if (job.claim.status !== "failed") {
      throw new Error(`claim is not in failed state (current: ${job.claim.status})`);
    }
    if (!job.result?.summary) {
      throw new Error("cannot retry claim: missing proof result");
    }

    job.claim.status = "queued";
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.claim.activeAttemptIndex = null;
    job.updatedAt = nowIso();
    await this.saveJob(job);
    await this.enqueueClaimJob(jobId);
    return job;
  }

  private shouldSkipAutomaticClaimRetry(job: ProofJobRecord): boolean {
    const claimAttempts = job.claimAttempts ?? [];
    let latestAttempt: ClaimAttempt | null = null;
    for (let index = claimAttempts.length - 1; index >= 0; index -= 1) {
      const attempt = claimAttempts[index];
      if (!attempt) {
        continue;
      }
      if (typeof attempt.error === "string" || typeof attempt.errorDetail === "string") {
        latestAttempt = attempt;
        break;
      }
    }
    const combined =
      `${job.claim.lastError ?? ""} ${latestAttempt?.error ?? ""} ${latestAttempt?.errorDetail ?? ""}`.toLowerCase();
    const deterministicMarkers = [
      "invalidjournalformat",
      "zeroscorenotallowed",
      "seednotactive",
      "contractpaused",
      "missing proof result for claim submission",
      "invalid proof artifact payload",
      "proof artifact journal_raw_hex does not match coordinator summary",
      "proof artifact journal_digest_hex does not match journal_raw_hex",
      "seal_hex must encode exactly",
      "journal_raw_hex must encode exactly",
      "journal_digest_hex must be a 32-byte lowercase hex string",
      "journal_digest_hex does not match journal_raw_hex",
    ];

    return (
      deterministicMarkers.some((marker) => combined.includes(marker)) ||
      /contract,\s*#(?:1|4|6|7)\b/.test(combined)
    );
  }

  private latestClaimActivityMs(job: ProofJobRecord): number {
    const candidates = [
      this.timestampMs(job.claim.lastAttemptAt ?? null),
      this.timestampMs(job.updatedAt),
      this.timestampMs(job.completedAt),
    ];
    const activeAttempt = this.getActiveClaimAttempt(job);
    if (activeAttempt) {
      candidates.push(this.timestampMs(activeAttempt.startedAt));
      candidates.push(this.timestampMs(activeAttempt.endedAt));
    } else {
      const latestAttempt = job.claimAttempts.at(-1);
      if (latestAttempt) {
        candidates.push(this.timestampMs(latestAttempt.startedAt));
        candidates.push(this.timestampMs(latestAttempt.endedAt));
      }
    }
    return Math.max(...candidates, 0);
  }

  /**
   * Automatically recover unfinished claims that got stuck after queue or
   * relayer failures. Called from runMaintenance() every minute. Applies a
   * cooldown between retries and a total attempt cap to avoid infinite loops.
   */
  private async autoRecoverUnfinishedClaims(): Promise<{
    claimsRequeued: number;
    staleQueuedClaimsRequeued: number;
    staleRetryingClaimsRequeued: number;
    staleSubmittingClaimsRecovered: number;
  }> {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec(`SELECT job_id FROM jobs WHERE status = 'succeeded'`)
      .toArray();

    const now = Date.now();
    const result = {
      claimsRequeued: 0,
      staleQueuedClaimsRequeued: 0,
      staleRetryingClaimsRequeued: 0,
      staleSubmittingClaimsRecovered: 0,
    };

    /* eslint-disable no-await-in-loop */
    for (const row of rows) {
      const job = await this.loadJob(row.job_id as string);
      if (!job) continue;
      if (job.claim.status === "succeeded") continue;
      if (!job.result?.summary) continue;

      const totalAttempts = (job.claimAttempts ?? []).length;
      if (totalAttempts >= MAX_CLAIM_AUTO_RETRIES) continue;
      if (this.shouldSkipAutomaticClaimRetry(job)) continue;

      const activityAgeMs = now - this.latestClaimActivityMs(job);
      if (activityAgeMs < CLAIM_AUTO_RETRY_COOLDOWN_MS) continue;

      let shouldRequeue = false;
      let recoveredStaleSubmitting = false;
      let category: "failed" | "queued" | "retrying" | "submitting" | null = null;

      if (job.claim.status === "failed") {
        shouldRequeue = true;
        category = "failed";
      } else if (job.claim.status === "retrying") {
        const retryAtMs = this.timestampMs(job.claim.nextRetryAt ?? null);
        if (retryAtMs <= 0 || retryAtMs <= now) {
          shouldRequeue = true;
          category = "retrying";
        }
      } else if (job.claim.status === "submitting") {
        const recovered = this.closeActiveClaimAttempt(job, "failed", {
          error: "maintenance recovered stale claim submission",
          errorDetail: "claim remained in submitting beyond auto-retry cooldown",
        });
        if (recovered) {
          recoveredStaleSubmitting = true;
        }
        shouldRequeue = true;
        category = "submitting";
      }

      if (!shouldRequeue || !category) continue;

      try {
        console.log(
          `[maintenance] requeueing stale claim for job ${job.jobId} (${category}, attempts: ${totalAttempts})`,
        );
        job.claim.status = "queued";
        job.claim.lastError = null;
        job.claim.nextRetryAt = null;
        job.claim.activeAttemptIndex = null;
        job.updatedAt = nowIso();
        await this.saveJob(job);
        await this.enqueueClaimJob(job.jobId);
        result.claimsRequeued += 1;
        if (category === "retrying") result.staleRetryingClaimsRequeued += 1;
        if (recoveredStaleSubmitting) result.staleSubmittingClaimsRecovered += 1;
      } catch (error) {
        console.warn(
          `[maintenance] failed requeueing claim for ${job.jobId}: ${safeErrorMessage(error)}`,
        );
      }
    }
    /* eslint-enable no-await-in-loop */

    return result;
  }

  /**
   * Re-queues a proof that previously failed.
   *
   * backend:
   * - auto: prefer Boundless when configured, otherwise Vast
   * - boundless|vast: force a specific queue, if configured
   */
  async retryFailedProof(
    jobId: string,
    backend: "auto" | "boundless" | "vast" = "auto",
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }
    const blockedReason = getProofRetryBlockedReason(job);
    if (blockedReason === "not_failed") {
      if (job.status === "succeeded") {
        throw new Error("cannot retry proof: proof already succeeded");
      }
      throw new Error(`proof is not in failed state (current: ${job.status})`);
    }
    if (blockedReason === "has_result") {
      throw new Error("cannot retry proof: proof result already exists");
    }
    if (blockedReason === "superseded") {
      throw new Error("cannot retry proof: proof was superseded by a higher on-chain score");
    }
    if (blockedReason === "replay_locked") {
      throw new Error("cannot retry proof: replay is locked after external dispatch");
    }

    const hasBoundless = resolveBoundlessConfig(this.env) !== null;
    const hasVast = Boolean(this.env.PROVER_BASE_URL?.trim());

    let nextBackend: "boundless" | "vast" | null = null;
    if (backend === "boundless") {
      nextBackend = hasBoundless ? "boundless" : null;
    } else if (backend === "vast") {
      nextBackend = hasVast ? "vast" : null;
    } else if (hasBoundless) {
      nextBackend = "boundless";
    } else if (hasVast) {
      nextBackend = "vast";
    }
    if (!nextBackend) {
      throw new Error(`requested backend is not configured: ${backend}`);
    }

    const now = nowIso();
    job.status = "queued";
    job.createdAt = now; // Reset wall-time reference so the retried job isn't immediately killed
    job.updatedAt = now;
    job.completedAt = null;
    job.error = null;
    job.errorCode = null;
    job.timeoutPhase = null;
    job.queue.lastError = null;
    job.queue.nextRetryAt = null;
    job.queue.waitStartedAt = now;
    job.queue.waitElapsedMs = 0;
    this.clearDispatchLease(job);
    job.prover.jobId = null;
    job.prover.status = null;
    job.prover.statusUrl = null;
    job.prover.segmentLimitPo2 = null;
    job.prover.lastPolledAt = null;
    job.prover.pollingErrors = 0;
    job.prover.ipfsCid = null;
    job.prover.runStartedAt = null;
    job.prover.runElapsedMs = null;
    job.prover.activeAttemptIndex = null;
    job.claim.status = "queued";
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.claim.activeAttemptIndex = null;
    if (job.replayHash) {
      await this.reserveReplayForJob(job);
    }
    await this.saveJob(job);

    const queue = nextBackend === "boundless" ? this.env.PROOF_QUEUE : this.env.VAST_QUEUE;
    try {
      await queue.send({ jobId }, { contentType: "json" });
    } catch (error) {
      await this.markFailed(jobId, `failed enqueueing retry proof: ${safeErrorMessage(error)}`, {
        errorCode: "retry_enqueue_failed",
      });
    }

    const refreshed = await this.loadJob(jobId);
    return refreshed ?? job;
  }

  /**
   * Records a failed dispatch/submission attempt for a specific backend and
   * immediately tries the next backend in the fallback chain.
   *
   * Used by queue consumers when submission fails before a prover job is
   * accepted (no in-progress attempt exists yet).
   */
  async markDispatchFailedAndTryNextBackend(
    jobId: string,
    backend: ProverBackend,
    reason: string,
    enrichment?: {
      errorCode?: string | null;
      errorDetail?: string | null;
    },
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }
    if (this.replayDispatchLocked(job)) {
      return this.markFailed(jobId, `${reason} (replay locked after external dispatch)`, {
        errorCode: enrichment?.errorCode ?? "replay_locked_after_dispatch",
        errorDetail: enrichment?.errorDetail ?? null,
      });
    }

    this.clearDispatchLease(job);
    const now = nowIso();
    const openAttempt = this.getActiveProverAttempt(job);
    if (openAttempt) {
      openAttempt.endedAt = now;
      openAttempt.outcome = "failed";
      openAttempt.error = openAttempt.error ?? reason;
      if (enrichment?.errorCode !== undefined) openAttempt.errorCode = enrichment.errorCode;
      if (enrichment?.errorDetail !== undefined) openAttempt.errorDetail = enrichment.errorDetail;
      job.prover.activeAttemptIndex = null;
      await this.saveJob(job);
    } else {
      const syntheticAttempt: ProverAttempt = {
        index: job.proverAttempts.length,
        backend,
        startedAt: job.queue.lastAttemptAt ?? now,
        endedAt: now,
        outcome: "failed",
        error: reason,
        errorDetail: enrichment?.errorDetail ?? null,
        errorCode: enrichment?.errorCode ?? null,
        proverJobId: null,
        statusUrl: null,
        maxPriceUsd: null,
        minPriceWei: null,
        maxPriceWei: null,
        fundingModeUsed: null,
        marketBalanceBeforeWei: null,
        autoDepositWei: null,
        actualCostUsd: null,
        lockPriceWei: null,
        proverAddress: null,
        fulfillmentTxHash: null,
        programCycles: null,
        totalCycles: null,
      };
      job.proverAttempts.push(syntheticAttempt);
      await this.saveJob(job);
    }

    await this.tryNextProverBackend(jobId, job, reason);
    return await this.loadJob(jobId);
  }

  private async recordAttemptEnd(
    job: ProofJobRecord,
    outcome: "success" | "failed",
    error: string | null,
    enrichment?: {
      errorDetail?: string | null;
      errorCode?: string | null;
      actualCostUsd?: number | null;
      proverAddress?: string | null;
      fulfillmentTxHash?: string | null;
      programCycles?: number | null;
      totalCycles?: number | null;
    },
  ): Promise<void> {
    const current = this.getActiveProverAttempt(job);
    if (current) {
      current.endedAt = nowIso();
      current.outcome = outcome;
      current.error = error;
      if (enrichment) {
        if (enrichment.errorDetail !== undefined) current.errorDetail = enrichment.errorDetail;
        if (enrichment.errorCode !== undefined) current.errorCode = enrichment.errorCode;
        if (enrichment.actualCostUsd !== undefined)
          current.actualCostUsd = enrichment.actualCostUsd;
        if (enrichment.proverAddress !== undefined)
          current.proverAddress = enrichment.proverAddress;
        if (enrichment.fulfillmentTxHash !== undefined)
          current.fulfillmentTxHash = enrichment.fulfillmentTxHash;
        if (enrichment.programCycles !== undefined)
          current.programCycles = enrichment.programCycles;
        if (enrichment.totalCycles !== undefined) current.totalCycles = enrichment.totalCycles;
      }
      job.prover.activeAttemptIndex = null;
      await this.saveJob(job);
    }
  }

  /**
   * After a prover attempt fails, enqueue the job to the next backend's queue
   * instead of submitting directly. Boundless jobs go to PROOF_QUEUE (parallel),
   * VastAI jobs go to VAST_QUEUE (serial, 1-at-a-time).
   */
  private async tryNextProverBackend(
    jobId: string,
    job: ProofJobRecord,
    reason: string,
  ): Promise<void> {
    if (this.replayDispatchLocked(job)) {
      await this.markFailed(jobId, `${reason} (replay locked after external dispatch)`, {
        errorCode: "replay_locked_after_dispatch",
      });
      return;
    }

    const totalAttempts = job.proverAttempts.filter((a) => a.outcome !== "in_progress").length;
    if (totalAttempts >= MAX_TOTAL_PROVER_ATTEMPTS) {
      await this.markFailed(
        jobId,
        `all ${MAX_TOTAL_PROVER_ATTEMPTS} prover attempts exhausted. Last: ${reason}`,
      );
      return;
    }

    // Determine next backend (alternate starting from Boundless if available)
    const lastBackend =
      // eslint-disable-next-line unicorn/prefer-array-find -- findLast unavailable in worker lib target
      job.proverAttempts.filter((a) => a.outcome !== "in_progress").at(-1)?.backend ?? null;
    const hasBoundless = resolveBoundlessConfig(this.env) !== null;
    const hasVast = Boolean(this.env.PROVER_BASE_URL?.trim());

    let nextBackend: ProverBackend;
    if (lastBackend === "boundless" && hasVast) {
      nextBackend = "vast";
    } else if (lastBackend === "vast" && hasBoundless) {
      nextBackend = "boundless";
    } else if (hasBoundless) {
      nextBackend = "boundless";
    } else if (hasVast) {
      nextBackend = "vast";
    } else {
      await this.markFailed(jobId, "no prover backends configured");
      return;
    }

    // Clear current prover state and mark as queued for the next backend
    job.prover.jobId = null;
    job.prover.status = null;
    job.prover.statusUrl = null;
    job.prover.segmentLimitPo2 = null;
    job.prover.pollingErrors = 0;
    job.prover.lastPolledAt = null;
    job.prover.ipfsCid = null;
    job.prover.runStartedAt = null;
    job.prover.runElapsedMs = null;
    job.prover.activeAttemptIndex = null;
    job.status = "queued";
    job.queue.lastError = reason;
    job.queue.waitStartedAt = nowIso();
    job.queue.waitElapsedMs = 0;
    job.queue.nextRetryAt = null;
    this.clearDispatchLease(job);
    job.updatedAt = nowIso();
    job.errorCode = null;
    job.timeoutPhase = null;
    await this.saveJob(job);

    // Enqueue to the appropriate backend queue
    const queue = nextBackend === "boundless" ? this.env.PROOF_QUEUE : this.env.VAST_QUEUE;
    try {
      await queue.send({ jobId }, { contentType: "json" });
      console.log(
        `[coordinator] enqueued ${jobId} to ${nextBackend} queue (attempt ${totalAttempts + 1})`,
      );
    } catch (error) {
      await this.markFailed(
        jobId,
        `failed enqueueing to ${nextBackend} queue: ${safeErrorMessage(error)}`,
      );
    }
  }

  /**
   * Shared poll-result state machine. Both alarm() and kickAlarm() delegate
   * here after obtaining a ProverPollResult.
   *
   * @param scheduleNext  true from alarm() (schedules next alarm on "running"
   *                      and does backoff retries); false from kickAlarm()
   *                      (just writes the state update, no alarm scheduling).
   */
  private async applyPollResult(
    activeJobId: string,
    job: ProofJobRecord,
    pollResult: ProverPollResult,
    scheduleNext: boolean,
  ): Promise<void> {
    const pollIntervalMs = this.resolveProverPollIntervalMs();

    if (pollResult.type === "running") {
      job.prover.pollingErrors = 0;
      job.prover.status = pollResult.status;
      job.prover.lastPolledAt = nowIso();
      this.updateRunElapsed(job);
      job.updatedAt = nowIso();
      job.queue.lastError = null;
      job.queue.nextRetryAt = null;
      await this.saveJob(job);
      if (scheduleNext) {
        await this.scheduleAlarm(pollIntervalMs);
      }
      return;
    }

    if (pollResult.type === "success") {
      const summary = pollResult.summary;
      const artifactStorageKey = resultKey(activeJobId);
      try {
        await this.env.PROOF_ARTIFACTS.put(
          artifactStorageKey,
          JSON.stringify(pollResult.artifact, null, 2),
          {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { jobId: activeJobId },
          },
        );
      } catch (error) {
        if (scheduleNext) {
          // R2 write failed — retry with backoff rather than failing the job.
          job.prover.pollingErrors += 1;
          job.status = "retrying";
          job.queue.lastError = `failed writing proof artifact to R2: ${safeErrorMessage(error)}`;
          job.updatedAt = nowIso();
          const delaySec = retryDelaySeconds(job.prover.pollingErrors);
          job.queue.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
          await this.saveJob(job);
          await this.scheduleAlarm(delaySec * 1000);
        }
        // kickAlarm path: next kick will retry.
        return;
      }

      // Compute actualCostUsd from cached lockPriceWei if available
      const metadata = {
        ...(pollResult.metadata ?? {
          actualCostUsd: null,
          proverAddress: null,
          fulfillmentTxHash: null,
        }),
      };
      if (metadata.actualCostUsd == null) {
        const currentAttempt = this.getActiveProverAttempt(job);
        if (currentAttempt?.lockPriceWei) {
          try {
            const boundlessConfig = resolveBoundlessConfig(this.env);
            if (boundlessConfig) {
              const ethPrice = await fetchEthPriceUsd(
                boundlessConfig.rpcUrl,
                Number(boundlessConfig.chainId),
              );
              metadata.actualCostUsd = weiToUsd(BigInt(currentAttempt.lockPriceWei), ethPrice);
            }
          } catch {
            /* non-fatal */
          }
        }
      }

      await this.markSucceeded(activeJobId, summary, artifactStorageKey, metadata);
      return;
    }

    if (pollResult.type === "retry") {
      const retryEnrichment = {
        errorCode: pollResult.errorCode ?? null,
        errorDetail: pollResult.errorDetail ?? null,
      };

      if (pollResult.clearProverJob) {
        if (scheduleNext) {
          // Record this attempt as failed and try the next backend
          if (this.isBoundlessJob(job)) {
            await this.recordAttemptEnd(job, "failed", pollResult.message, retryEnrichment);
            await this.tryNextProverBackend(
              activeJobId,
              job,
              `boundless failed: ${pollResult.message}`,
            );
            return;
          }

          // Vast.ai job failed — try next backend via fallback system
          await this.recordAttemptEnd(job, "failed", pollResult.message, retryEnrichment);
          await this.tryNextProverBackend(activeJobId, job, `vast failed: ${pollResult.message}`);
          return;
        }

        // kickAlarm path: record failure and try next backend (same as alarm path).
        // Previously this only cleared prover state without falling back, leaving
        // the job stuck in "retrying" with no queue message and no prover.
        await this.recordAttemptEnd(job, "failed", pollResult.message, retryEnrichment);
        await this.tryNextProverBackend(
          activeJobId,
          job,
          `prover failed (recovered by kickAlarm): ${pollResult.message}`,
        );
        return;
      }

      // Transient poll error without clearing the prover job.
      job.prover.pollingErrors += 1;
      job.prover.lastPolledAt = nowIso();
      job.updatedAt = nowIso();
      job.queue.lastError = pollResult.message;
      if (scheduleNext) {
        job.status = "retrying";
        const delaySec = retryDelaySeconds(job.prover.pollingErrors);
        job.queue.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        await this.saveJob(job);
        await this.scheduleAlarm(delaySec * 1000);
      } else {
        await this.saveJob(job);
      }
      return;
    }

    // pollResult.type === "fatal"
    await this.markFailed(activeJobId, pollResult.message, {
      errorCode: pollResult.errorCode ?? null,
      errorDetail: pollResult.errorDetail ?? null,
    });
  }

  async alarm(): Promise<void> {
    let activeJobIds = this.getActiveJobIds();
    const maxWallTimeMs = this.resolveMaxProofTotalWallTimeMs();
    const maxProverRunTimeMs = this.resolveMaxProverRunTimeMs();

    if (activeJobIds.length === 0) {
      return;
    }
    let anyStillActive = false;

    /* eslint-disable no-await-in-loop */
    for (const jobId of activeJobIds) {
      const job = await this.loadJob(jobId);
      if (!job || isTerminalProofStatus(job.status)) {
        continue;
      }

      const jobAgeMs = Date.now() - new Date(job.createdAt).getTime();
      if (jobAgeMs > maxWallTimeMs) {
        const recovered = await this.maybeRecoverTimedOutBoundlessJob(jobId, job);
        if (recovered && !isTerminalProofStatus(recovered.status)) {
          anyStillActive = true;
          continue;
        }
        if (recovered?.status === "succeeded") {
          continue;
        }
        const ageMin = Math.round(jobAgeMs / 60_000);
        await this.markFailed(jobId, `proof job timed out after ${ageMin} minutes`, {
          errorCode: "job_total_wall_timeout",
          timeoutPhase: "total_wall",
        });
        continue;
      }

      if (!job.prover.jobId) {
        // waiting for queue consumer to dispatch
        this.updateQueueWaitElapsed(job);
        await this.saveJob(job);
        anyStillActive = true;
        continue;
      }

      this.updateRunElapsed(job);
      const runElapsedMs = job.prover.runElapsedMs ?? 0;
      if (!this.isBoundlessJob(job) && runElapsedMs > maxProverRunTimeMs) {
        const runMin = Math.round(runElapsedMs / 60_000);
        const reason = `proof run timed out after ${runMin} minutes while occupying prover slot`;
        console.log(`[coordinator] vast job ${jobId} — ${reason}, falling back`);
        await this.recordAttemptEnd(job, "failed", reason, {
          errorCode: "prover_run_timeout",
        });
        await this.tryNextProverBackend(jobId, job, reason);
        const fallbackJob = await this.loadJob(jobId);
        if (fallbackJob && !isTerminalProofStatus(fallbackJob.status)) {
          anyStillActive = true;
        }
        continue;
      }

      // Poll prover — single-shot check; the alarm reschedules itself if
      // the job is still running, so there is no need for an inner polling loop.
      let pollResult: ProverPollResult;
      let boundlessConfig: ReturnType<typeof resolveBoundlessConfig> = null;
      try {
        if (this.isBoundlessJob(job)) {
          boundlessConfig = resolveBoundlessConfig(this.env);
          if (!boundlessConfig) {
            await this.markFailed(jobId, "boundless config missing during alarm poll");
            continue;
          }
          pollResult = await new BoundlessClient(boundlessConfig).pollOnce(job.prover.jobId);
        } else {
          pollResult = await pollProverOnce(this.env, job.prover.jobId);
        }
      } catch (error) {
        job.prover.pollingErrors += 1;
        job.status = "retrying";
        job.updatedAt = nowIso();
        job.queue.lastError = `poll error: ${safeErrorMessage(error)}`;
        const delaySec = retryDelaySeconds(job.prover.pollingErrors);
        job.queue.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        await this.saveJob(job);

        // Even though the poll failed, check the Boundless-specific timeout.
        // Without this, sustained poll errors would delay fallback until the
        // 3-hour total wall-time timeout instead of the 30-60 min Boundless limit.
        if (this.isBoundlessJob(job) && boundlessConfig) {
          const currentAttempt = this.getActiveProverAttempt(job);
          if (currentAttempt) {
            const attemptAgeMs = Date.now() - new Date(currentAttempt.startedAt).getTime();
            const fullTimeoutMs =
              (boundlessConfig.flatPeriodSec + boundlessConfig.timeoutSec) * 1000;
            if (attemptAgeMs > fullTimeoutMs) {
              const elapsedSec = Math.round(attemptAgeMs / 1000);
              const reason = `boundless timed out after ${elapsedSec}s (poll unreachable)`;
              console.log(
                `[coordinator] boundless order ${job.prover.jobId} — ${reason}, falling back`,
              );
              await this.recordAttemptEnd(job, "failed", reason);
              await this.tryNextProverBackend(jobId, job, reason);
              const fallbackJob = await this.loadJob(jobId);
              if (fallbackJob && !isTerminalProofStatus(fallbackJob.status)) {
                anyStillActive = true;
              }
              continue;
            }
          }
        }

        anyStillActive = true;
        continue;
      }

      // Boundless fallback: two-tier timeout based on lock status.
      //
      // Tier 1 — Lock window (flat + lockTimeout, default 30 min):
      //   If no prover has locked the order, bail to Vast.ai. No point waiting
      //   once the lock window closes — no new provers will lock after that.
      //
      // Tier 2 — Full timeout (flat + timeout, default 60 min):
      //   If a prover HAS locked the order, give them until the order expires
      //   on-chain. A locked prover can still deliver after lockTimeout (their
      //   collateral is slashed but they can still submit the proof).
      //
      // If lock status is unknown (RPC error → undefined), treat as unlocked
      // and use the poll timeout (tier 1).
      if (pollResult.type === "running" && boundlessConfig) {
        const currentAttempt = this.getActiveProverAttempt(job);
        if (currentAttempt) {
          const attemptAgeMs = Date.now() - new Date(currentAttempt.startedAt).getTime();
          const isLocked = pollResult.locked === true;

          // Cache the lock price while it's available (contract clears it after payment)
          if (pollResult.lockPriceWei && !currentAttempt.lockPriceWei) {
            currentAttempt.lockPriceWei = pollResult.lockPriceWei.toString();
            await this.saveJob(job);
          }

          // If locked, extend wait up to the full lock deadline; otherwise use poll timeout
          const lockWindowMs =
            (boundlessConfig.flatPeriodSec + boundlessConfig.lockTimeoutSec) * 1000;
          const fullTimeoutMs = (boundlessConfig.flatPeriodSec + boundlessConfig.timeoutSec) * 1000;
          const deadlineMs = isLocked
            ? fullTimeoutMs
            : Math.max(boundlessConfig.pollTimeoutMs, lockWindowMs);

          if (attemptAgeMs > deadlineMs) {
            const elapsedSec = Math.round(attemptAgeMs / 1000);
            const reason = isLocked
              ? `prover locked order but did not deliver after ${elapsedSec}s`
              : `no prover locked the order after ${elapsedSec}s`;
            console.log(
              `[coordinator] boundless order ${job.prover.jobId} — ${reason}, falling back`,
            );
            await this.recordAttemptEnd(job, "failed", reason);
            await this.tryNextProverBackend(jobId, job, reason);
            const fallbackJob = await this.loadJob(jobId);
            if (fallbackJob && !isTerminalProofStatus(fallbackJob.status)) {
              anyStillActive = true;
            }
            continue;
          }
        }
      }

      await this.applyPollResult(jobId, job, pollResult, true);

      const updatedJob = await this.loadJob(jobId);
      if (updatedJob && !isTerminalProofStatus(updatedJob.status)) {
        anyStillActive = true;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (anyStillActive) {
      const pollIntervalMs = this.resolveProverPollIntervalMs();
      await this.scheduleAlarm(pollIntervalMs);
    }
  }

  async kickAlarm(): Promise<void> {
    const activeJobIds = this.getActiveJobIds();
    if (activeJobIds.length === 0) {
      return;
    }

    const maxWallTimeMs = this.resolveMaxProofTotalWallTimeMs();

    /* eslint-disable no-await-in-loop */
    for (const activeJobId of activeJobIds) {
      const job = await this.loadJob(activeJobId);
      if (!job || isTerminalProofStatus(job.status)) {
        continue;
      }

      // Apply wall-time timeout directly — don't rely on alarm() for this,
      // because the alarm chain may be dead after a server restart.
      const jobAgeMs = Date.now() - new Date(job.createdAt).getTime();
      if (jobAgeMs > maxWallTimeMs) {
        const recovered = await this.maybeRecoverTimedOutBoundlessJob(activeJobId, job);
        if (recovered && !isTerminalProofStatus(recovered.status)) {
          await this.scheduleAlarm(MIN_PROVER_POLL_INTERVAL_MS);
          continue;
        }
        if (recovered?.status === "succeeded") {
          continue;
        }
        const ageMin = Math.round(jobAgeMs / 60_000);
        await this.markFailed(activeJobId, `proof job timed out after ${ageMin} minutes`, {
          errorCode: "job_total_wall_timeout",
          timeoutPhase: "total_wall",
        });
        continue;
      }

      const proverJobId = job.prover.jobId;
      if (!proverJobId) {
        // No prover job yet — the queue consumer handles submission.
        // Just ensure the alarm is scheduled.
        await this.scheduleAlarm(MIN_PROVER_POLL_INTERVAL_MS);
        continue;
      }

      // Apply Vast prover run timeout: if a non-Boundless job has been
      // running longer than the prover slot limit, fail and fall back.
      if (!this.isBoundlessJob(job)) {
        this.updateRunElapsed(job);
        const runElapsedMs = job.prover.runElapsedMs ?? 0;
        const maxProverRunTimeMs = this.resolveMaxProverRunTimeMs();
        if (runElapsedMs > maxProverRunTimeMs) {
          const runMin = Math.round(runElapsedMs / 60_000);
          const reason = `proof run timed out after ${runMin} minutes while occupying prover slot`;
          await this.recordAttemptEnd(job, "failed", reason, {
            errorCode: "prover_run_timeout",
          });
          await this.tryNextProverBackend(activeJobId, job, reason);
          continue;
        }
      }

      // Apply Boundless two-tier timeout: if the attempt has been running
      // longer than the order's on-chain lifetime, fail and fall back.
      if (this.isBoundlessJob(job)) {
        const boundlessConfig = resolveBoundlessConfig(this.env);
        if (boundlessConfig) {
          const currentAttempt = this.getActiveProverAttempt(job);
          if (currentAttempt) {
            const attemptAgeMs = Date.now() - new Date(currentAttempt.startedAt).getTime();
            const fullTimeoutMs =
              (boundlessConfig.flatPeriodSec + boundlessConfig.timeoutSec) * 1000;
            if (attemptAgeMs > fullTimeoutMs) {
              const elapsedSec = Math.round(attemptAgeMs / 1000);
              const reason = `boundless order expired after ${elapsedSec}s (recovered by kickAlarm)`;
              await this.recordAttemptEnd(job, "failed", reason);
              await this.tryNextProverBackend(activeJobId, job, reason);
              continue;
            }
          }
        }
      }

      let pollResult: ProverPollResult;
      try {
        if (this.isBoundlessJob(job)) {
          const boundlessConfig = resolveBoundlessConfig(this.env);
          if (!boundlessConfig) {
            job.prover.pollingErrors += 1;
            job.prover.lastPolledAt = nowIso();
            job.updatedAt = nowIso();
            job.queue.lastError = "boundless config missing during poll";
            await this.saveJob(job);
            continue;
          }
          pollResult = await new BoundlessClient(boundlessConfig).pollOnce(proverJobId);
        } else {
          pollResult = await pollProverOnce(this.env, proverJobId);
        }
      } catch (error) {
        job.prover.pollingErrors += 1;
        job.prover.lastPolledAt = nowIso();
        job.updatedAt = nowIso();
        job.queue.lastError = `poll error: ${safeErrorMessage(error)}`;
        await this.saveJob(job);
        continue;
      }

      await this.applyPollResult(activeJobId, job, pollResult, false);
    }
    /* eslint-enable no-await-in-loop */

    // Ensure the alarm chain is running. If the server was restarted (or the
    // DO was evicted) the alarm may have been lost — this restarts it so
    // alarm() can apply its full timeout / fallback logic on the next tick.
    // Also reschedule if the existing alarm is in the past (stale from a
    // previous session that never fired).
    const currentAlarm = await this.ctx.storage.getAlarm();
    const alarmMissing = currentAlarm == null || currentAlarm < Date.now();
    if (alarmMissing) {
      const remaining = this.getActiveJobIds();
      if (remaining.length > 0) {
        await this.scheduleAlarm(MIN_PROVER_POLL_INTERVAL_MS);
      }
    }
  }

  async listJobsForClaimant(
    claimantAddress: string,
    limit: number,
    offset: number,
  ): Promise<{ jobs: ProofJobRecord[]; total: number }> {
    const countRow = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) as cnt FROM jobs WHERE claimant_address = ?`, claimantAddress)
      .toArray();
    const total = Number((countRow[0] as { cnt: number }).cnt);

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT data FROM jobs WHERE claimant_address = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        claimantAddress,
        limit,
        offset,
      )
      .toArray();

    const jobs: ProofJobRecord[] = [];
    for (const row of rows) {
      const job = JSON.parse(row.data as string) as ProofJobRecord;
      const recovered = await this.maybeRecoverTimedOutBoundlessJob(job.jobId, job);
      jobs.push(recovered ?? job);
    }
    return { jobs, total };
  }
}
