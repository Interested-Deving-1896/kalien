import {
  DEFAULT_MAX_JOB_WALL_TIME_MS,
  MAX_QUEUE_RETRIES,
  MAX_VAST_QUEUE_RETRIES,
  VAST_SLOT_BUSY_RETRY_DELAY_SECONDS,
} from "../constants";
import { submitClaim } from "../claim/submit";
import { resolveBoundlessConfig } from "../boundless/config";
import { submitToBoundless } from "../boundless/client";
import { coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { writeProofTapeMapping } from "../leaderboard-store";
import { submitToProver } from "../prover/client";
import type { ClaimQueueMessage, ProofJobRecord, ProofQueueMessage, ProofJournal } from "../types";
import { isTerminalProofStatus, parseInteger, retryDelaySeconds, safeErrorMessage } from "../utils";

/**
 * Returns true when a fatal claim error actually indicates the score was
 * already submitted on-chain by a prior attempt. The contract rejects
 * duplicate journals ("already claimed") and non-improving scores ("score not
 * improved"), both of which prove the claim landed previously.
 */
function isAlreadyClaimedOnChain(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("already claimed") || m.includes("score not improved");
}

function journalRawHex(journal: ProofJournal): string {
  const buf = new Uint8Array(24);
  const view = new DataView(buf.buffer);
  view.setUint32(0, journal.seed >>> 0, true);
  view.setUint32(4, journal.frame_count >>> 0, true);
  view.setUint32(8, journal.final_score >>> 0, true);
  view.setUint32(12, journal.final_rng_state >>> 0, true);
  view.setUint32(16, journal.tape_checksum >>> 0, true);
  view.setUint32(20, journal.rules_digest >>> 0, true);
  return Array.from(buf)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromHex(hex: string): Promise<string> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Shared pre-submission checks
// ---------------------------------------------------------------------------

interface PreparedJob {
  jobId: string;
  job: ProofJobRecord;
  tapeBytes: Uint8Array;
}

/**
 * Common validation that runs before any prover submission. Returns the job
 * record and tape bytes if the job is ready for submission, or null if the
 * message has already been ack'd/retried.
 */
async function prepareForSubmission(
  message: Message<ProofQueueMessage>,
  env: WorkerEnv,
  _maxRetries: number,
): Promise<PreparedJob | null> {
  const payload = message.body;
  if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
    message.ack();
    return null;
  }

  const jobId = payload.jobId;
  const maxWallTimeMs = parseInteger(
    env.MAX_JOB_WALL_TIME_MS,
    DEFAULT_MAX_JOB_WALL_TIME_MS,
    60_000,
  );

  const coordinator = coordinatorStub(env);
  const startedJob = await coordinator.beginQueueAttempt(jobId, message.attempts);
  if (!startedJob || isTerminalProofStatus(startedJob.status)) {
    message.ack();
    return null;
  }

  if (startedJob.tape.metadata.finalScore >>> 0 === 0) {
    await coordinator.markFailed(jobId, "zero-score runs are not accepted");
    message.ack();
    return null;
  }

  // If the prover job already exists (re-delivered message after crash),
  // beginQueueAttempt ensured the alarm is running. Just ack.
  if (startedJob.prover.jobId) {
    message.ack();
    return null;
  }

  const jobAgeMs = Date.now() - new Date(startedJob.createdAt).getTime();
  if (jobAgeMs > maxWallTimeMs) {
    const ageMin = Math.round(jobAgeMs / 60_000);
    await coordinator.markFailed(
      jobId,
      `proof job timed out after ${ageMin} minutes (attempt ${message.attempts})`,
    );
    message.ack();
    return null;
  }

  const tapeObject = await env.PROOF_ARTIFACTS.get(startedJob.tape.key);
  if (!tapeObject) {
    await coordinator.markFailed(jobId, "missing tape artifact in R2");
    message.ack();
    return null;
  }

  const tapeBytes = new Uint8Array(await tapeObject.arrayBuffer());
  return { jobId, job: startedJob, tapeBytes };
}

/**
 * Handle the result of a prover submission, updating coordinator state and
 * ack/retrying the queue message.
 */
async function handleSubmitResult(
  submitResult: Awaited<ReturnType<typeof submitToProver>>,
  jobId: string,
  message: Message<ProofQueueMessage>,
  env: WorkerEnv,
  maxRetries: number,
): Promise<void> {
  const coordinator = coordinatorStub(env);

  if (submitResult.type === "retry") {
    if (message.attempts >= maxRetries) {
      await coordinator.markFailed(
        jobId,
        `${submitResult.message} (exhausted ${message.attempts} delivery attempts)`,
      );
      message.ack();
      return;
    }

    const delaySeconds = retryDelaySeconds(message.attempts);
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await coordinator.markRetry(jobId, submitResult.message, nextRetryAt);
    message.retry({ delaySeconds });
    return;
  }

  if (submitResult.type === "fatal") {
    await coordinator.markFailed(jobId, submitResult.message);
    message.ack();
    return;
  }

  // Submission succeeded — markProverAccepted sets the first alarm for polling.
  await coordinator.markProverAccepted(
    jobId,
    submitResult.jobId,
    submitResult.statusUrl,
    submitResult.segmentLimitPo2,
    undefined, // recoveryAttempts
    submitResult.ipfsCid,
    submitResult.maxPriceUsd,
  );
  message.ack();
}

// ---------------------------------------------------------------------------
// Boundless queue consumer (PROOF_QUEUE — parallel)
// ---------------------------------------------------------------------------

async function processBoundlessMessage(
  message: Message<ProofQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  const prepared = await prepareForSubmission(message, env, MAX_QUEUE_RETRIES);
  if (!prepared) return;

  const { jobId, tapeBytes } = prepared;
  const coordinator = coordinatorStub(env);

  const boundlessConfig = resolveBoundlessConfig(env);
  if (!boundlessConfig) {
    // Boundless not configured — this shouldn't happen in normal flow,
    // but if it does, fail gracefully and let the coordinator handle fallback.
    await coordinator.markFailed(jobId, "boundless backend not configured");
    message.ack();
    return;
  }

  let submitResult: Awaited<ReturnType<typeof submitToBoundless>>;
  try {
    submitResult = await submitToBoundless(boundlessConfig, tapeBytes);
  } catch (error) {
    const reason = `boundless submit error: ${safeErrorMessage(error)}`;
    if (message.attempts >= MAX_QUEUE_RETRIES) {
      await coordinator.markFailed(
        jobId,
        `${reason} (exhausted ${message.attempts} delivery attempts)`,
      );
      message.ack();
      return;
    }

    const delaySeconds = retryDelaySeconds(message.attempts);
    await coordinator.markRetry(
      jobId,
      reason,
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
    );
    message.retry({ delaySeconds });
    return;
  }

  await handleSubmitResult(submitResult, jobId, message, env, MAX_QUEUE_RETRIES);
}

// ---------------------------------------------------------------------------
// VastAI queue consumer (VAST_QUEUE — serial, 1-at-a-time)
// ---------------------------------------------------------------------------

async function processVastMessage(
  message: Message<ProofQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  const payload = message.body;
  if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
    message.ack();
    return;
  }

  const coordinator = coordinatorStub(env);

  // Enforce 1-at-a-time: if a VastAI job is already running, re-queue.
  const slotBusy = await coordinator.hasActiveVastJob();
  if (slotBusy) {
    if (message.attempts >= MAX_VAST_QUEUE_RETRIES) {
      await coordinator.markFailed(
        payload.jobId,
        `vast slot busy for too long (exhausted ${message.attempts} delivery attempts)`,
      );
      message.ack();
      return;
    }
    message.retry({ delaySeconds: VAST_SLOT_BUSY_RETRY_DELAY_SECONDS });
    return;
  }

  const prepared = await prepareForSubmission(message, env, MAX_VAST_QUEUE_RETRIES);
  if (!prepared) return;

  const { jobId, tapeBytes } = prepared;

  let submitResult: Awaited<ReturnType<typeof submitToProver>>;
  try {
    submitResult = await submitToProver(env, tapeBytes, {});
  } catch (error) {
    const reason = `vast submit error: ${safeErrorMessage(error)}`;
    if (message.attempts >= MAX_VAST_QUEUE_RETRIES) {
      await coordinator.markFailed(
        jobId,
        `${reason} (exhausted ${message.attempts} delivery attempts)`,
      );
      message.ack();
      return;
    }

    const delaySeconds = retryDelaySeconds(message.attempts);
    await coordinator.markRetry(
      jobId,
      reason,
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
    );
    message.retry({ delaySeconds });
    return;
  }

  await handleSubmitResult(submitResult, jobId, message, env, MAX_VAST_QUEUE_RETRIES);
}

// ---------------------------------------------------------------------------
// Claim queue (unchanged)
// ---------------------------------------------------------------------------

async function processClaimQueueMessage(
  message: Message<ClaimQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  const payload = message.body;
  if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
    message.ack();
    return;
  }

  const coordinator = coordinatorStub(env);
  const job = await coordinator.beginClaimAttempt(payload.jobId, message.attempts);
  if (!job) {
    message.ack();
    return;
  }

  if (job.status !== "succeeded") {
    message.ack();
    return;
  }

  if (job.claim.status === "succeeded") {
    message.ack();
    return;
  }

  if (!job.result?.summary || !job.result?.artifactKey) {
    await coordinator.markClaimFailed(payload.jobId, "missing proof result for claim submission");
    message.ack();
    return;
  }

  const artifact = await env.PROOF_ARTIFACTS.get(job.result.artifactKey);
  if (!artifact) {
    await coordinator.markClaimFailed(payload.jobId, "missing proof artifact in R2");
    message.ack();
    return;
  }

  let artifactJson: { prover_response?: unknown };
  try {
    artifactJson = (await artifact.json()) as { prover_response?: unknown };
  } catch (error) {
    await coordinator.markClaimFailed(
      payload.jobId,
      `failed parsing proof artifact json: ${safeErrorMessage(error)}`,
    );
    message.ack();
    return;
  }

  const journalHex = journalRawHex(job.result.summary.journal);
  const digestHex = await sha256HexFromHex(journalHex);

  let relayResult: Awaited<ReturnType<typeof submitClaim>>;
  try {
    relayResult = await submitClaim(env, {
      jobId: payload.jobId,
      claimantAddress: job.claim.claimantAddress,
      journalRawHex: journalHex,
      journalDigestHex: digestHex,
      proverResponse: artifactJson.prover_response ?? null,
    });
  } catch (error) {
    const reason = `claim submit error: ${safeErrorMessage(error)}`;
    const crashDetail = error instanceof Error ? error.stack ?? error.message : String(error);
    if (message.attempts >= MAX_QUEUE_RETRIES) {
      await coordinator.markClaimFailed(
        payload.jobId,
        `${reason} (exhausted ${message.attempts} delivery attempts)`,
        crashDetail,
      );
      message.ack();
      return;
    }

    const delaySeconds = retryDelaySeconds(message.attempts);
    await coordinator.markClaimRetry(
      payload.jobId,
      reason,
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
      crashDetail,
    );
    message.retry({ delaySeconds });
    return;
  }

  if (relayResult.type === "success") {
    console.log("[claim-queue] claim result", {
      jobId: payload.jobId,
      type: relayResult.type,
      txHash: relayResult.txHash,
    });
    await coordinator.markClaimSucceeded(payload.jobId, relayResult.txHash);
    try {
      await writeProofTapeMapping(env, relayResult.txHash, payload.jobId);
    } catch (err) {
      console.error("[claim-queue] failed to write tape mapping", err);
    }
    message.ack();
    return;
  }

  if (relayResult.type === "retry") {
    console.log("[claim-queue] claim result", {
      jobId: payload.jobId,
      type: relayResult.type,
      message: relayResult.message,
      attempts: message.attempts,
    });
    if (message.attempts >= MAX_QUEUE_RETRIES) {
      await coordinator.markClaimFailed(
        payload.jobId,
        `${relayResult.message} (exhausted ${message.attempts} delivery attempts)`,
        relayResult.errorDetail,
      );
      message.ack();
      return;
    }

    const delaySeconds = retryDelaySeconds(message.attempts);
    await coordinator.markClaimRetry(
      payload.jobId,
      relayResult.message,
      new Date(Date.now() + delaySeconds * 1000).toISOString(),
      relayResult.errorDetail,
    );
    message.retry({ delaySeconds });
    return;
  }

  console.log("[claim-queue] claim result", {
    jobId: payload.jobId,
    type: relayResult.type,
    message: relayResult.message,
  });

  // Contract rejections like "already claimed" or "score not improved" mean a
  // prior attempt actually landed on-chain. Treat as success rather than failure.
  if (isAlreadyClaimedOnChain(relayResult.message)) {
    console.log("[claim-queue] fatal error indicates prior on-chain success", {
      jobId: payload.jobId,
    });
    await coordinator.markClaimSucceeded(payload.jobId, "prior-attempt");
    message.ack();
    return;
  }

  await coordinator.markClaimFailed(payload.jobId, relayResult.message, relayResult.errorDetail);
  message.ack();
}

// ---------------------------------------------------------------------------
// Batch handlers (exported)
// ---------------------------------------------------------------------------

/**
 * Boundless proof queue — processes in parallel (Cloudflare handles concurrency
 * via max_concurrency in wrangler config).
 */
export async function handleQueueBatch(
  batch: MessageBatch<ProofQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const message of batch.messages) {
    await processBoundlessMessage(message, env);
  }
  /* eslint-enable no-await-in-loop */
}

/**
 * VastAI proof queue — serial, 1-at-a-time (max_concurrency=1 in wrangler).
 * Consumer checks for an active VastAI slot before submitting.
 */
export async function handleVastQueueBatch(
  batch: MessageBatch<ProofQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const message of batch.messages) {
    await processVastMessage(message, env);
  }
  /* eslint-enable no-await-in-loop */
}

/**
 * Handles messages that land in the dead-letter queue after all retries are
 * exhausted. This is a safety net — the primary consumer already detects last
 * attempts and marks jobs failed. The DLQ catches edge cases like unhandled
 * consumer crashes on the final delivery.
 */
export async function handleDlqBatch(
  batch: MessageBatch<ProofQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const message of batch.messages) {
    const payload = message.body;
    if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
      message.ack();
      continue;
    }

    const coordinator = coordinatorStub(env);
    const job = await coordinator.getJob(payload.jobId);

    if (job && !isTerminalProofStatus(job.status)) {
      await coordinator.markFailed(
        payload.jobId,
        "proof job failed: all queue delivery attempts exhausted (dead-letter)",
      );
    }

    message.ack();
  }
  /* eslint-enable no-await-in-loop */
}

export async function handleClaimQueueBatch(
  batch: MessageBatch<ClaimQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const message of batch.messages) {
    try {
      await processClaimQueueMessage(message, env);
    } catch (error) {
      const payload = message.body;
      if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
        message.ack();
        continue;
      }

      const reason = `claim queue consumer crashed: ${safeErrorMessage(error)}`;
      const crashDetail = error instanceof Error ? error.stack ?? error.message : String(error);
      const coordinator = coordinatorStub(env);
      if (message.attempts >= MAX_QUEUE_RETRIES) {
        await coordinator.markClaimFailed(
          payload.jobId,
          `${reason} (exhausted ${message.attempts} delivery attempts)`,
          crashDetail,
        );
        message.ack();
      } else {
        const delaySeconds = retryDelaySeconds(message.attempts);
        await coordinator.markClaimRetry(
          payload.jobId,
          reason,
          new Date(Date.now() + delaySeconds * 1000).toISOString(),
          crashDetail,
        );
        message.retry({ delaySeconds });
      }
    }
  }
  /* eslint-enable no-await-in-loop */
}

export async function handleClaimDlqBatch(
  batch: MessageBatch<ClaimQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
  /* eslint-disable no-await-in-loop */
  for (const message of batch.messages) {
    const payload = message.body;
    if (!payload || typeof payload.jobId !== "string" || payload.jobId.length === 0) {
      message.ack();
      continue;
    }

    const coordinator = coordinatorStub(env);
    const job = await coordinator.getJob(payload.jobId);
    const priorError = job?.claim.lastError?.trim() ?? "";

    // If the last error indicates the claim already landed on-chain via a
    // prior attempt, treat this as success rather than failure.
    if (priorError.length > 0 && isAlreadyClaimedOnChain(priorError)) {
      console.log("[claim-dlq] prior error indicates on-chain success", {
        jobId: payload.jobId,
        priorError,
      });
      await coordinator.markClaimSucceeded(payload.jobId, "prior-attempt");
      message.ack();
      continue;
    }

    const dlqMessage =
      priorError.length > 0
        ? `${priorError} (dead-letter)`
        : "claim submission failed: all queue delivery attempts exhausted (dead-letter)";
    await coordinator.markClaimFailed(payload.jobId, dlqMessage);
    message.ack();
  }
  /* eslint-enable no-await-in-loop */
}
