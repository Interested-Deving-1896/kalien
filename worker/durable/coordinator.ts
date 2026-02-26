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
  LEADERBOARD_EVENT_KEY_PREFIX,
  LEADERBOARD_INGESTION_STATE_KEY,
  MAX_TOTAL_PROVER_ATTEMPTS,
  PROFILE_KEY_PREFIX,
} from "../constants";
import { resolveBoundlessConfig } from "../boundless/config";
import { pollBoundless, pollBoundlessOnce } from "../boundless/client";
import { unpinInput } from "../boundless/storage";
import type { WorkerEnv } from "../env";
import { jobKey, resultKey, tapeKey } from "../keys";
import { pollProver, pollProverOnce, summarizeProof } from "../prover/client";
import type {
  CreateJobAccepted,
  LeaderboardEventRecord,
  LeaderboardIngestionState,
  PlayerProfileRecord,
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

export function coordinatorStub(env: WorkerEnv): DurableObjectStub<ProofCoordinatorDO> {
  const id = env.PROOF_COORDINATOR.idFromName(COORDINATOR_OBJECT_NAME);
  return env.PROOF_COORDINATOR.get(id);
}

export function asPublicJob(job: ProofJobRecord): PublicProofJob {
  // For legacy jobs that predate proverAttempts, synthesize a single attempt
  // from the prover tracking data so the UI can show meaningful backend/attempt info.
  let proverAttempts = job.proverAttempts ?? [];
  if (proverAttempts.length === 0 && job.prover.jobId) {
    const backend: ProverBackend = job.prover.statusUrl?.startsWith("boundless:")
      ? "boundless"
      : "vast";
    const outcome: ProverAttempt["outcome"] =
      job.status === "succeeded"
        ? "success"
        : isTerminalProofStatus(job.status)
          ? "failed"
          : "in_progress";
    proverAttempts = [
      {
        index: 0,
        backend,
        startedAt: job.createdAt,
        endedAt: job.completedAt,
        outcome,
        error: job.error,
        proverJobId: job.prover.jobId,
        statusUrl: job.prover.statusUrl,
      },
    ];
  }

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

  private profileKey(claimantAddress: string): string {
    return `${PROFILE_KEY_PREFIX}${claimantAddress}`;
  }

  private leaderboardEventKey(eventId: string): string {
    return `${LEADERBOARD_EVENT_KEY_PREFIX}${eventId}`;
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
        recoveryAttempts: 0,
      },
      proverAttempts: [],
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

  async getProfile(claimantAddress: string): Promise<PlayerProfileRecord | null> {
    return (
      (await this.ctx.storage.get<PlayerProfileRecord>(this.profileKey(claimantAddress))) ?? null
    );
  }

  async getProfiles(claimantAddresses: string[]): Promise<Record<string, PlayerProfileRecord>> {
    const unique = Array.from(
      new Set(claimantAddresses.filter((value) => value.trim().length > 0)),
    );
    const entries = await Promise.all(
      unique.map(async (address) => [address, await this.getProfile(address)] as const),
    );

    const out: Record<string, PlayerProfileRecord> = {};
    for (const [address, profile] of entries) {
      if (profile) {
        out[address] = profile;
      }
    }
    return out;
  }

  async listLeaderboardProfiles(): Promise<PlayerProfileRecord[]> {
    const listPageSize = 256;
    const profiles: PlayerProfileRecord[] = [];
    let startAfter: string | undefined;

    /* eslint-disable no-await-in-loop */
    while (true) {
      const page = await this.listLeaderboardProfilesPage({
        startAfter,
        limit: listPageSize,
      });
      if (page.profiles.length === 0) {
        break;
      }

      profiles.push(...page.profiles);
      if (!page.nextStartAfter || page.done) {
        break;
      }
      startAfter = page.nextStartAfter;
    }
    /* eslint-enable no-await-in-loop */

    return profiles;
  }

  async listLeaderboardProfilesPage(options?: {
    startAfter?: string | null;
    limit?: number | null;
  }): Promise<{
    profiles: PlayerProfileRecord[];
    nextStartAfter: string | null;
    done: boolean;
  }> {
    const limitRaw = options?.limit ?? 256;
    const limit = Math.min(Math.max(Math.trunc(limitRaw), 1), 2000);
    const startAfter = options?.startAfter ?? undefined;
    const page = await this.ctx.storage.list<PlayerProfileRecord>({
      prefix: PROFILE_KEY_PREFIX,
      startAfter: startAfter ?? undefined,
      limit,
    });
    if (page.size === 0) {
      return {
        profiles: [],
        nextStartAfter: null,
        done: true,
      };
    }

    const profiles: PlayerProfileRecord[] = [];
    for (const [, value] of page) {
      if (value?.claimantAddress) {
        profiles.push(value);
      }
    }

    const pageKeys = Array.from(page.keys());
    const lastKey = pageKeys[pageKeys.length - 1];
    const done = !lastKey || page.size < limit;
    return {
      profiles,
      nextStartAfter: done ? null : lastKey,
      done,
    };
  }

  async upsertProfile(
    claimantAddress: string,
    updates: { username: string | null; linkUrl: string | null },
  ): Promise<PlayerProfileRecord> {
    const profile: PlayerProfileRecord = {
      claimantAddress,
      username: updates.username,
      linkUrl: updates.linkUrl,
      updatedAt: nowIso(),
    };

    await this.ctx.storage.put(this.profileKey(claimantAddress), profile);
    return profile;
  }

  async listLeaderboardEvents(): Promise<LeaderboardEventRecord[]> {
    const listPageSize = 256;
    const events: LeaderboardEventRecord[] = [];
    let startAfter: string | undefined;

    /* eslint-disable no-await-in-loop */
    while (true) {
      const page = await this.listLeaderboardEventsPage({
        startAfter,
        limit: listPageSize,
      });
      if (page.events.length === 0) {
        break;
      }

      events.push(...page.events);
      if (!page.nextStartAfter || page.done) {
        break;
      }
      startAfter = page.nextStartAfter;
    }
    /* eslint-enable no-await-in-loop */

    return events;
  }

  async listLeaderboardEventsPage(options?: {
    startAfter?: string | null;
    limit?: number | null;
  }): Promise<{
    events: LeaderboardEventRecord[];
    nextStartAfter: string | null;
    done: boolean;
  }> {
    const limitRaw = options?.limit ?? 256;
    const limit = Math.min(Math.max(Math.trunc(limitRaw), 1), 2000);
    const startAfter = options?.startAfter ?? undefined;
    const page = await this.ctx.storage.list<LeaderboardEventRecord>({
      prefix: LEADERBOARD_EVENT_KEY_PREFIX,
      startAfter: startAfter ?? undefined,
      limit,
    });
    if (page.size === 0) {
      return {
        events: [],
        nextStartAfter: null,
        done: true,
      };
    }

    const events: LeaderboardEventRecord[] = [];
    for (const [, value] of page) {
      if (value?.eventId) {
        events.push(value);
      }
    }

    const pageKeys = Array.from(page.keys());
    const lastKey = pageKeys[pageKeys.length - 1];
    const done = !lastKey || page.size < limit;
    return {
      events,
      nextStartAfter: done ? null : lastKey,
      done,
    };
  }

  async upsertLeaderboardEvents(
    events: LeaderboardEventRecord[],
  ): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    /* eslint-disable no-await-in-loop */
    for (const event of events) {
      const key = this.leaderboardEventKey(event.eventId);
      const existing = await this.ctx.storage.get<LeaderboardEventRecord>(key);
      if (!existing) {
        inserted += 1;
      } else if (JSON.stringify(existing) !== JSON.stringify(event)) {
        updated += 1;
      } else {
        continue;
      }

      await this.ctx.storage.put(key, event);
    }
    /* eslint-enable no-await-in-loop */

    return { inserted, updated };
  }

  async getLeaderboardIngestionState(): Promise<LeaderboardIngestionState> {
    const current =
      (await this.ctx.storage.get<LeaderboardIngestionState>(LEADERBOARD_INGESTION_STATE_KEY)) ??
      null;
    if (current) {
      return {
        provider: current.provider === "rpc" ? "rpc" : "galexie",
        sourceMode:
          current.sourceMode === "rpc" ||
          current.sourceMode === "events_api" ||
          current.sourceMode === "datalake"
            ? current.sourceMode
            : current.provider === "rpc"
              ? "rpc"
              : "datalake",
        cursor: current.cursor ?? null,
        highestLedger: current.highestLedger ?? null,
        lastSyncedAt: current.lastSyncedAt ?? null,
        lastBackfillAt: current.lastBackfillAt ?? null,
        totalEvents: current.totalEvents ?? 0,
        lastError: current.lastError ?? null,
      };
    }

    return {
      provider: "galexie",
      sourceMode: "datalake",
      cursor: null,
      highestLedger: null,
      lastSyncedAt: null,
      lastBackfillAt: null,
      totalEvents: 0,
      lastError: null,
    };
  }

  async setLeaderboardIngestionState(state: LeaderboardIngestionState): Promise<void> {
    await this.ctx.storage.put(LEADERBOARD_INGESTION_STATE_KEY, state);
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
    recoveryAttempts?: number,
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
    job.prover.recoveryAttempts = recoveryAttempts ?? job.prover.recoveryAttempts;
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
        proverJobId,
        statusUrl,
        maxPriceUsd: maxPriceUsd ?? null,
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
    job.error = null;
    job.claim.status = "queued";
    job.claim.lastError = null;
    job.claim.nextRetryAt = null;

    await this.saveJob(job);
    await this.recordAttemptEnd(job, "success", null);
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

  async markFailed(jobId: string, reason: string): Promise<ProofJobRecord | null> {
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
    await this.saveJob(job);
    return job;
  }

  async markClaimRetry(
    jobId: string,
    reason: string,
    nextRetryAt: string,
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
    await this.saveJob(job);
    return job;
  }

  async markClaimFailed(jobId: string, reason: string): Promise<ProofJobRecord | null> {
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
      await this.saveJob(job);
      return job;
    }

    job.claim.status = "failed";
    job.claim.lastError = reason;
    job.claim.nextRetryAt = null;
    job.updatedAt = nowIso();
    await this.saveJob(job);
    return job;
  }

  private async recordAttemptEnd(
    job: ProofJobRecord,
    outcome: "success" | "failed",
    error: string | null,
  ): Promise<void> {
    const current = job.proverAttempts.find((a) => a.outcome === "in_progress");
    if (current) {
      current.endedAt = nowIso();
      current.outcome = outcome;
      current.error = error;
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
      console.log(`[coordinator] enqueued ${jobId} to ${nextBackend} queue (attempt ${totalAttempts + 1})`);
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

      await this.markSucceeded(activeJobId, summary, artifactStorageKey);
      return;
    }

    if (pollResult.type === "retry") {
      if (pollResult.clearProverJob) {
        if (scheduleNext) {
          // Record this attempt as failed and try the next backend
          if (this.isBoundlessJob(job)) {
            await this.recordAttemptEnd(job, "failed", pollResult.message);
            await this.tryNextProverBackend(
              activeJobId,
              job,
              `boundless failed: ${pollResult.message}`,
            );
            return;
          }

          // Vast.ai job failed — try next backend via fallback system
          await this.recordAttemptEnd(job, "failed", pollResult.message);
          await this.tryNextProverBackend(activeJobId, job, `vast failed: ${pollResult.message}`);
          return;
        }

        // kickAlarm path: just clear prover job, let alarm handle recovery.
        job.prover.jobId = null;
        job.prover.status = null;
        job.prover.statusUrl = null;
        job.prover.lastPolledAt = nowIso();
        job.prover.pollingErrors += 1;
        job.prover.recoveryAttempts += 1;
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
    await this.markFailed(activeJobId, pollResult.message);
  }

  async alarm(): Promise<void> {
    let activeJobIds = await this.getActiveJobIds();
    const maxWallTimeMs = parseInteger(
      this.env.MAX_JOB_WALL_TIME_MS,
      DEFAULT_MAX_JOB_WALL_TIME_MS,
      60_000,
    );

    // Recover orphaned non-terminal jobs that predate ACTIVE_JOBS_KEY.
    // These jobs were created before we started tracking active job IDs, so
    // the alarm would never pick them up. We scan once to adopt them.
    {
      const activeSet = new Set(activeJobIds);
      let orphanFound = false;
      const listPageSize = 128;
      let startAfter: string | undefined;
      /* eslint-disable no-await-in-loop */
      while (true) {
        const page = await this.ctx.storage.list<ProofJobRecord>({
          prefix: JOB_KEY_PREFIX,
          startAfter,
          limit: listPageSize,
        });
        if (page.size === 0) break;
        for (const [, value] of page) {
          if (value && !isTerminalProofStatus(value.status) && !activeSet.has(value.jobId)) {
            activeJobIds = [...activeJobIds, value.jobId];
            activeSet.add(value.jobId);
            await this.addActiveJobId(value.jobId);
            orphanFound = true;
          }
        }
        const pageKeys = Array.from(page.keys());
        const lastKey = pageKeys[pageKeys.length - 1];
        if (!lastKey || page.size < listPageSize) break;
        startAfter = lastKey;
      }
      /* eslint-enable no-await-in-loop */
      if (orphanFound) {
        console.log(
          `[proof-worker] adopted ${activeJobIds.length} orphaned job(s) into active set`,
        );
      }
    }

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
          pollResult = await pollBoundless(
            boundlessConfig,
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
          pollResult = await pollBoundlessOnce(boundlessConfig, proverJobId);
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
