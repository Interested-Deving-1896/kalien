import { DurableObject } from "cloudflare:workers";
import {
  ACTIVE_JOBS_KEY,
  COORDINATOR_OBJECT_NAME,
  DEFAULT_BOUNDLESS_POLL_BUDGET_MS,
  DEFAULT_COMPLETED_JOB_RETENTION_MS,
  DEFAULT_MAX_JOB_WALL_TIME_MS,
  DEFAULT_MAX_COMPLETED_JOBS,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_PROVER_POLL_INTERVAL_MS,
  JOB_KEY_PREFIX,
  MAX_TOTAL_PROVER_ATTEMPTS,
} from "../constants";
import { resolveBoundlessConfig } from "../boundless/config";
import { BoundlessClient, fetchBoundlessCycles } from "../boundless/sdk/client";
import { fetchEthPriceUsd, weiToUsd } from "../boundless/pricing";
import { unpinInput } from "../boundless/storage";
import type { WorkerEnv } from "../env";
import { jobKey, resultKey, tapeKey } from "../keys";
import { pollProver, pollProverOnce, summarizeProof } from "../prover/client";
import type {
  ClaimAttempt,
  CreateJobAccepted,
  ProofJobRecord,
  ProofResultSummary,
  ProverAttempt,
  ProverBackend,
  ProverPollResult,
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

export function coordinatorStub(env: WorkerEnv): DurableObjectStub<ProofCoordinatorDO> {
  const id = env.PROOF_COORDINATOR.idFromName(COORDINATOR_OBJECT_NAME);
  return env.PROOF_COORDINATOR.get(id);
}

export function asPublicJob(job: ProofJobRecord): PublicProofJob {
  const proverAttempts = (job.proverAttempts ?? []).map((a) => ({
    ...a,
    errorDetail: a.errorDetail ?? null,
    errorCode: a.errorCode ?? null,
    actualCostUsd: a.actualCostUsd != null && a.actualCostUsd <= 1000 ? a.actualCostUsd : null,
    proverAddress: a.proverAddress ?? null,
    fulfillmentTxHash: a.fulfillmentTxHash ?? null,
    programCycles: a.programCycles ?? null,
    totalCycles: a.totalCycles ?? null,
  }));

  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    tape: {
      sizeBytes: job.tape.sizeBytes,
      metadata: job.tape.metadata,
    },
    queue: job.queue,
    prover: job.prover,
    proverAttempts,
    claimAttempts: job.claimAttempts ?? [],
    result: job.result,
    claim: job.claim,
    error: job.error,
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

  private async deleteArtifact(key: string | null | undefined): Promise<void> {
    if (!key) {
      return;
    }

    try {
      await this.env.PROOF_ARTIFACTS.delete(key);
    } catch (error) {
      console.warn(`[proof-worker] failed deleting artifact ${key}: ${safeErrorMessage(error)}`);
    }
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

  private async pruneCompletedJobs(): Promise<void> {
    const maxCompletedJobs = parseInteger(
      this.env.MAX_COMPLETED_JOBS,
      DEFAULT_MAX_COMPLETED_JOBS,
      1,
    );
    const retentionMs = parseInteger(
      this.env.COMPLETED_JOB_RETENTION_MS,
      DEFAULT_COMPLETED_JOB_RETENTION_MS,
      60_000,
    );
    const nowMs = Date.now();

    const completed: Array<{
      storageKey: string;
      job: ProofJobRecord;
      terminalAtMs: number;
    }> = [];

    const listPageSize = 128;
    let startAfter: string | undefined;
    /* eslint-disable no-await-in-loop */
    while (true) {
      const page = await this.ctx.storage.list<ProofJobRecord>({
        prefix: JOB_KEY_PREFIX,
        startAfter,
        limit: listPageSize,
      });
      if (page.size === 0) {
        break;
      }

      for (const [storageKey, value] of page) {
        if (!value || !isTerminalProofStatus(value.status)) {
          continue;
        }

        completed.push({
          storageKey,
          job: value,
          terminalAtMs: Math.max(
            this.timestampMs(value.completedAt),
            this.timestampMs(value.updatedAt),
            this.timestampMs(value.createdAt),
          ),
        });
      }

      const pageKeys = Array.from(page.keys());
      const lastKey = pageKeys[pageKeys.length - 1];
      if (!lastKey || page.size < listPageSize) {
        break;
      }

      startAfter = lastKey;
    }
    /* eslint-enable no-await-in-loop */

    if (completed.length === 0) {
      return;
    }

    completed.sort((a, b) => a.terminalAtMs - b.terminalAtMs);

    const toDelete = new Set<string>();
    for (const entry of completed) {
      if (nowMs - entry.terminalAtMs > retentionMs) {
        toDelete.add(entry.storageKey);
      }
    }

    const overflow = Math.max(0, completed.length - maxCompletedJobs);
    for (let index = 0; index < overflow; index += 1) {
      toDelete.add(completed[index].storageKey);
    }

    if (toDelete.size === 0) {
      return;
    }

    /* eslint-disable no-await-in-loop */
    for (const entry of completed) {
      if (!toDelete.has(entry.storageKey)) {
        continue;
      }

      await this.ctx.storage.delete(entry.storageKey);
      await this.deleteArtifact(entry.job.tape.key);
      // result.json is intentionally kept in R2 so users can fetch proof
      // data after the DO record is pruned.  The R2 lifecycle rule
      // (expire-proof-jobs, 7 days) handles cleanup.
    }
    /* eslint-enable no-await-in-loop */
  }

  private async getActiveJobIds(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(ACTIVE_JOBS_KEY)) ?? [];
  }

  private async addActiveJobId(jobId: string): Promise<void> {
    const current = await this.getActiveJobIds();
    if (!current.includes(jobId)) {
      await this.ctx.storage.put(ACTIVE_JOBS_KEY, [...current, jobId]);
    }
  }

  private async removeActiveJobId(jobId: string): Promise<void> {
    const current = await this.getActiveJobIds();
    const updated = current.filter((id) => id !== jobId);
    await this.ctx.storage.put(ACTIVE_JOBS_KEY, updated);
  }

  private async loadJob(jobId: string): Promise<ProofJobRecord | null> {
    return (await this.ctx.storage.get<ProofJobRecord>(jobKey(jobId))) ?? null;
  }

  private async saveJob(job: ProofJobRecord): Promise<void> {
    await this.ctx.storage.put(jobKey(job.jobId), job);
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
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

  async createJob(
    tapeInfo: Omit<ProofTapeInfo, "key"> & { claimantAddress: string },
  ): Promise<CreateJobAccepted> {
    const { claimantAddress, ...proofTape } = tapeInfo;

    const jobId = crypto.randomUUID();
    const now = nowIso();

    const job: ProofJobRecord = {
      jobId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      tape: {
        ...proofTape,
        key: tapeKey(jobId),
      },
      queue: {
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
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
      },
      error: null,
    };

    await this.saveJob(job);
    await this.addActiveJobId(jobId);

    return {
      accepted: true,
      job,
    };
  }

  async getJob(jobId: string): Promise<ProofJobRecord | null> {
    return this.loadJob(jobId);
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

    // Only enrich succeeded Boundless jobs missing cycle data
    if (job.status !== "succeeded") return job;
    const attempt = this.getLatestSuccessfulAttempt(job);
    if (!attempt || attempt.totalCycles != null) return job;
    if (!this.isBoundlessSuccessAttempt(job, attempt)) return job;

    const requestIdHex = this.getBoundlessRequestId(job, attempt);
    if (!requestIdHex) return job;

    try {
      const chainId = this.getBoundlessChainId();
      const { programCycles, totalCycles } = await fetchBoundlessCycles(
        chainId,
        requestIdHex,
      );
      if (totalCycles != null) {
        attempt.programCycles = programCycles;
        attempt.totalCycles = totalCycles;
        await this.saveJob(job);
      }
    } catch (error) {
      // Non-fatal — indexer may be down; next read will retry.
      console.warn(
        `[coordinator] cycle backfill failed for ${jobId} (${requestIdHex}): ${safeErrorMessage(error)}`,
      );
    }
    return job;
  }

  async getActiveJob(): Promise<ProofJobRecord | null> {
    const activeJobIds = await this.getActiveJobIds();
    for (const jobId of activeJobIds) {
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
    const activeJobIds = await this.getActiveJobIds();
    for (const jobId of activeJobIds) {
      const job = await this.loadJob(jobId);
      if (
        job &&
        !isTerminalProofStatus(job.status) &&
        job.prover.jobId &&
        !this.isBoundlessJob(job)
      ) {
        return true;
      }
    }
    return false;
  }

  async listSucceededJobs(): Promise<ProofJobRecord[]> {
    const listPageSize = 128;
    const jobs: ProofJobRecord[] = [];
    let startAfter: string | undefined;

    /* eslint-disable no-await-in-loop */
    while (true) {
      const page = await this.ctx.storage.list<ProofJobRecord>({
        prefix: JOB_KEY_PREFIX,
        startAfter,
        limit: listPageSize,
      });
      if (page.size === 0) {
        break;
      }

      for (const [, value] of page) {
        if (value?.status === "succeeded" && value.result?.summary) {
          jobs.push(value);
        }
      }

      const pageKeys = Array.from(page.keys());
      const lastKey = pageKeys[pageKeys.length - 1];
      if (!lastKey || page.size < listPageSize) {
        break;
      }
      startAfter = lastKey;
    }
    /* eslint-enable no-await-in-loop */

    return jobs;
  }

  async beginQueueAttempt(jobId: string, attempts: number): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }

    const now = nowIso();
    job.status = job.prover.jobId ? "prover_running" : "dispatching";
    job.updatedAt = now;
    job.queue.attempts = Math.max(job.queue.attempts, attempts);
    job.queue.lastAttemptAt = now;
    job.queue.nextRetryAt = null;
    await this.saveJob(job);

    // Re-delivered queue message after crash: prover job already exists,
    // ensure alarm is running so polling resumes. Consumer will just ack.
    if (job.prover.jobId) {
      const pollIntervalMs = parseInteger(
        this.env.PROVER_POLL_INTERVAL_MS,
        DEFAULT_POLL_INTERVAL_MS,
        MIN_PROVER_POLL_INTERVAL_MS,
      );
      await this.scheduleAlarm(pollIntervalMs);
    }

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
    if (clearProverJob) {
      job.prover.jobId = null;
      job.prover.status = null;
      job.prover.statusUrl = null;
      job.prover.segmentLimitPo2 = null;
      job.prover.lastPolledAt = null;
      job.prover.pollingErrors = 0;
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
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      return job;
    }

    job.status = "prover_running";
    job.updatedAt = nowIso();
    job.queue.lastError = null;
    job.queue.nextRetryAt = null;
    job.prover.jobId = proverJobId;
    job.prover.status = "queued";
    job.prover.statusUrl = statusUrl;
    job.prover.segmentLimitPo2 = segmentLimitPo2;
    job.prover.pollingErrors = 0;
    if (ipfsCid) {
      job.prover.ipfsCid = ipfsCid;
    }
    await this.saveJob(job);

    // Track the attempt. If no in_progress attempt exists, start a new one.
    // This covers both the initial submission (proverAttempts empty) and
    // retry submissions after failover to a different backend queue.
    const hasInProgress = job.proverAttempts.some((a) => a.outcome === "in_progress");
    if (!hasInProgress) {
      const backend: ProverBackend = statusUrl.startsWith("boundless:") ? "boundless" : "vast";
      const attempt: ProverAttempt = {
        index: job.proverAttempts.length,
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
        actualCostUsd: null,
        proverAddress: null,
        fulfillmentTxHash: null,
        programCycles: null,
        totalCycles: null,
      };
      job.proverAttempts.push(attempt);
      await this.saveJob(job);
    }

    const pollIntervalMs = parseInteger(
      this.env.PROVER_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_PROVER_POLL_INTERVAL_MS,
    );
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

    const now = nowIso();
    job.status = "succeeded";
    job.updatedAt = now;
    job.completedAt = now;
    job.queue.lastError = null;
    job.queue.nextRetryAt = null;
    job.prover.status = "succeeded";
    job.prover.lastPolledAt = now;
    job.result = {
      artifactKey,
      summary,
    };
    // Journal claimant is the canonical reward recipient used on-chain.
    // Keep coordinator state aligned with the proof journal once verified.
    job.claim.claimantAddress = summary.journal.claimant;
    job.error = null;
    job.claim.status = "queued";
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;

    await this.saveJob(job);
    await this.recordAttemptEnd(job, "success", null, enrichment);
    await this.removeActiveJobId(jobId);
    await this.unpinIpfsInput(job);
    await this.enqueueClaimJob(jobId);
    try {
      await this.pruneCompletedJobs();
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
    },
  ): Promise<ProofJobRecord | null> {
    const job = await this.loadJob(jobId);
    if (!job) {
      return null;
    }

    // Close any lingering in-progress attempt so the UI shows it as failed
    const openAttempt = job.proverAttempts.find((a) => a.outcome === "in_progress");
    if (openAttempt) {
      openAttempt.endedAt = nowIso();
      openAttempt.outcome = "failed";
      openAttempt.error = openAttempt.error ?? reason;
      if (enrichment) {
        if (enrichment.errorDetail !== undefined) openAttempt.errorDetail = enrichment.errorDetail;
        if (enrichment.errorCode !== undefined) openAttempt.errorCode = enrichment.errorCode;
      }
    }

    const now = nowIso();
    job.status = "failed";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = reason;
    job.queue.lastError = reason;
    job.queue.nextRetryAt = null;
    if (job.prover.status !== "succeeded") {
      job.prover.status = "failed";
      job.prover.lastPolledAt = now;
    }
    if (job.claim.status !== "succeeded") {
      job.claim.status = "failed";
      job.claim.lastError = `proof failed before on-chain claim: ${reason}`;
      job.claim.nextRetryAt = null;
    }

    await this.saveJob(job);
    await this.removeActiveJobId(jobId);
    await this.unpinIpfsInput(job);
    try {
      await this.pruneCompletedJobs();
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

    job.claim.status = "submitting";
    job.claim.attempts = Math.max(job.claim.attempts, attempts);
    job.claim.lastAttemptAt = nowIso();
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();

    // Track individual claim attempt
    const claimAttempts = job.claimAttempts ?? [];
    const attempt: ClaimAttempt = {
      index: claimAttempts.length,
      startedAt: nowIso(),
      endedAt: null,
      outcome: "in_progress",
      error: null,
      errorDetail: null,
      txHash: null,
    };
    claimAttempts.push(attempt);
    job.claimAttempts = claimAttempts;

    await this.saveJob(job);
    return job;
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

    // End current in-progress claim attempt as failed
    const openClaimAttempt = (job.claimAttempts ?? []).find((a) => a.outcome === "in_progress");
    if (openClaimAttempt) {
      openClaimAttempt.endedAt = nowIso();
      openClaimAttempt.outcome = "failed";
      openClaimAttempt.error = reason;
      openClaimAttempt.errorDetail = errorDetail ?? null;
    }

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

    // End current in-progress claim attempt as success
    const openClaimAttempt = (job.claimAttempts ?? []).find((a) => a.outcome === "in_progress");
    if (openClaimAttempt) {
      openClaimAttempt.endedAt = nowIso();
      openClaimAttempt.outcome = "success";
      openClaimAttempt.txHash = txHash;
    }

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

      const openClaimAttempt = (job.claimAttempts ?? []).find((a) => a.outcome === "in_progress");
      if (openClaimAttempt) {
        openClaimAttempt.endedAt = nowIso();
        openClaimAttempt.outcome = "success";
        openClaimAttempt.txHash = job.claim.txHash;
      }

      await this.saveJob(job);
      return job;
    }

    job.claim.status = "failed";
    job.claim.lastError = reason;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();

    const openClaimAttempt = (job.claimAttempts ?? []).find((a) => a.outcome === "in_progress");
    if (openClaimAttempt) {
      openClaimAttempt.endedAt = nowIso();
      openClaimAttempt.outcome = "failed";
      openClaimAttempt.error = reason;
      openClaimAttempt.errorDetail = errorDetail ?? null;
    }

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
    job.updatedAt = nowIso();
    await this.saveJob(job);
    await this.enqueueClaimJob(jobId);
    return job;
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
    const current = job.proverAttempts.find((a) => a.outcome === "in_progress");
    if (current) {
      current.endedAt = nowIso();
      current.outcome = outcome;
      current.error = error;
      if (enrichment) {
        if (enrichment.errorDetail !== undefined) current.errorDetail = enrichment.errorDetail;
        if (enrichment.errorCode !== undefined) current.errorCode = enrichment.errorCode;
        if (enrichment.actualCostUsd !== undefined) current.actualCostUsd = enrichment.actualCostUsd;
        if (enrichment.proverAddress !== undefined) current.proverAddress = enrichment.proverAddress;
        if (enrichment.fulfillmentTxHash !== undefined) current.fulfillmentTxHash = enrichment.fulfillmentTxHash;
        if (enrichment.programCycles !== undefined) current.programCycles = enrichment.programCycles;
        if (enrichment.totalCycles !== undefined) current.totalCycles = enrichment.totalCycles;
      }
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
    job.status = "queued";
    job.queue.lastError = reason;
    job.updatedAt = nowIso();
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
    const pollIntervalMs = parseInteger(
      this.env.PROVER_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_PROVER_POLL_INTERVAL_MS,
    );

    if (pollResult.type === "running") {
      job.prover.pollingErrors = 0;
      job.prover.status = pollResult.status;
      job.prover.lastPolledAt = nowIso();
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
      let summary: Awaited<ReturnType<typeof summarizeProof>>;
      try {
        summary = summarizeProof(pollResult.response);
      } catch (error) {
        await this.markFailed(
          activeJobId,
          `invalid prover success payload: ${safeErrorMessage(error)}`,
        );
        return;
      }

      const artifactStorageKey = resultKey(activeJobId);
      try {
        await this.env.PROOF_ARTIFACTS.put(
          artifactStorageKey,
          JSON.stringify({ stored_at: nowIso(), prover_response: pollResult.response }, null, 2),
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
      const metadata = { ...(pollResult.metadata ?? { actualCostUsd: null, proverAddress: null, fulfillmentTxHash: null }) };
      if (metadata.actualCostUsd == null) {
        const currentAttempt = job.proverAttempts?.find((a) => a.outcome === "in_progress");
        if (currentAttempt?.lockPriceWei) {
          try {
            const boundlessConfig = resolveBoundlessConfig(this.env);
            if (boundlessConfig) {
              const ethPrice = await fetchEthPriceUsd(boundlessConfig.rpcUrl, Number(boundlessConfig.chainId));
              metadata.actualCostUsd = weiToUsd(BigInt(currentAttempt.lockPriceWei), ethPrice);
            }
          } catch { /* non-fatal */ }
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

        // kickAlarm path: just clear prover job, let alarm handle recovery.
        job.prover.jobId = null;
        job.prover.status = null;
        job.prover.statusUrl = null;
        job.prover.lastPolledAt = nowIso();
        job.prover.pollingErrors += 1;
        job.status = "retrying";
        job.updatedAt = nowIso();
        job.queue.lastError = pollResult.message;
        await this.saveJob(job);
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
    let activeJobIds = await this.getActiveJobIds();
    const maxWallTimeMs = parseInteger(
      this.env.MAX_JOB_WALL_TIME_MS,
      DEFAULT_MAX_JOB_WALL_TIME_MS,
      60_000,
    );

    if (activeJobIds.length === 0) {
      return;
    }
    let anyStillActive = false;

    /* eslint-disable no-await-in-loop */
    for (const jobId of activeJobIds) {
      const job = await this.loadJob(jobId);
      if (!job) {
        await this.removeActiveJobId(jobId);
        continue;
      }
      if (isTerminalProofStatus(job.status)) {
        await this.removeActiveJobId(jobId);
        continue;
      }

      const jobAgeMs = Date.now() - new Date(job.createdAt).getTime();
      if (jobAgeMs > maxWallTimeMs) {
        const ageMin = Math.round(jobAgeMs / 60_000);
        await this.markFailed(jobId, `proof job timed out after ${ageMin} minutes`);
        continue;
      }

      if (!job.prover.jobId) {
        // waiting for queue consumer to dispatch
        anyStillActive = true;
        continue;
      }

      // Poll prover
      let pollResult: ProverPollResult;
      let boundlessConfig: ReturnType<typeof resolveBoundlessConfig> = null;
      try {
        if (this.isBoundlessJob(job)) {
          boundlessConfig = resolveBoundlessConfig(this.env);
          if (!boundlessConfig) {
            await this.markFailed(jobId, "boundless config missing during alarm poll");
            continue;
          }
          pollResult = await new BoundlessClient(boundlessConfig).poll(
            job.prover.jobId,
            DEFAULT_BOUNDLESS_POLL_BUDGET_MS,
          );
        } else {
          pollResult = await pollProver(this.env, job.prover.jobId);
        }
      } catch (error) {
        job.prover.pollingErrors += 1;
        job.status = "retrying";
        job.updatedAt = nowIso();
        job.queue.lastError = `poll error: ${safeErrorMessage(error)}`;
        const delaySec = retryDelaySeconds(job.prover.pollingErrors);
        job.queue.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        await this.saveJob(job);
        anyStillActive = true;
        continue;
      }

      // Boundless fallback: two-tier timeout based on lock status.
      //
      // Tier 1 — Poll timeout (BOUNDLESS_POLL_TIMEOUT_MS, default 10 min):
      //   If no prover has locked the order, bail to Vast.ai. No point waiting
      //   for the full lock window if nobody is interested.
      //
      // Tier 2 — Lock deadline (flat period + lock timeout, default 30 min):
      //   If a prover HAS locked the order, give them until the lock deadline
      //   to deliver. Only bail if they fail to deliver by then.
      //
      // If lock status is unknown (RPC error → undefined), treat as unlocked
      // and use the poll timeout (tier 1).
      if (pollResult.type === "running" && boundlessConfig) {
        const currentAttempt = job.proverAttempts.find((a) => a.outcome === "in_progress");
        if (currentAttempt) {
          const attemptAgeMs = Date.now() - new Date(currentAttempt.startedAt).getTime();
          const isLocked = pollResult.locked === true;

          // Cache the lock price while it's available (contract clears it after payment)
          if (pollResult.lockPriceWei && !currentAttempt.lockPriceWei) {
            currentAttempt.lockPriceWei = pollResult.lockPriceWei.toString();
            await this.saveJob(job);
          }

          // If locked, extend wait up to the full lock deadline; otherwise use poll timeout
          const deadlineMs = isLocked
            ? (boundlessConfig.flatPeriodSec + boundlessConfig.lockTimeoutSec) * 1000
            : boundlessConfig.pollTimeoutMs;

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
      const pollIntervalMs = parseInteger(
        this.env.PROVER_POLL_INTERVAL_MS,
        DEFAULT_POLL_INTERVAL_MS,
        MIN_PROVER_POLL_INTERVAL_MS,
      );
      await this.scheduleAlarm(pollIntervalMs);
    }
  }

  async kickAlarm(): Promise<void> {
    const activeJobIds = await this.getActiveJobIds();
    if (activeJobIds.length === 0) {
      return;
    }

    /* eslint-disable no-await-in-loop */
    for (const activeJobId of activeJobIds) {
      const job = await this.loadJob(activeJobId);
      if (!job || isTerminalProofStatus(job.status)) {
        continue;
      }

      const proverJobId = job.prover.jobId;
      if (!proverJobId) {
        // No prover job yet — the queue consumer handles submission.
        // Just ensure the alarm is scheduled.
        await this.scheduleAlarm(MIN_PROVER_POLL_INTERVAL_MS);
        continue;
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
  }

  async listJobsForClaimant(
    claimantAddress: string,
    limit: number,
    offset: number,
  ): Promise<{ jobs: ProofJobRecord[]; total: number }> {
    const all: ProofJobRecord[] = [];
    const listPageSize = 128;
    let startAfter: string | undefined;

    /* eslint-disable no-await-in-loop */
    while (true) {
      const page = await this.ctx.storage.list<ProofJobRecord>({
        prefix: JOB_KEY_PREFIX,
        startAfter,
        limit: listPageSize,
      });
      if (page.size === 0) {
        break;
      }

      for (const [, value] of page) {
        if (value?.claim?.claimantAddress === claimantAddress) {
          all.push(value);
        }
      }

      const pageKeys = Array.from(page.keys());
      const lastKey = pageKeys[pageKeys.length - 1];
      if (!lastKey || page.size < listPageSize) {
        break;
      }
      startAfter = lastKey;
    }
    /* eslint-enable no-await-in-loop */

    // Sort newest first
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = all.length;
    const jobs = all.slice(offset, offset + limit);
    return { jobs, total };
  }
}
