import {
  DEFAULT_MAX_PROOF_TOTAL_WALL_TIME_MS,
  MAX_QUEUE_RETRIES,
  MAX_VAST_QUEUE_RETRIES,
  VAST_SLOT_BUSY_RETRY_DELAY_SECONDS,
} from "../constants";
import { submitClaim } from "../claim/submit";
import { resolveBoundlessConfig } from "../boundless/config";
import { BoundlessClient } from "../boundless/sdk/client";
import { coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { writeProofClaimIndexEntry, writeProofTapeMapping } from "../leaderboard-store";
import { hexToBytes, parseProofArtifactV4, sha256Hex } from "../proof-artifact";
import { submitToProver } from "../prover/client";
import type {
  ClaimQueueMessage,
  ProofJobRecord,
  ProofJournal,
  ProofQueueMessage,
  ProverBackend,
} from "../types";
import { isTerminalProofStatus, parseInteger, retryDelaySeconds, safeErrorMessage } from "../utils";
import { packJournalRaw } from "../../shared/stellar/journal";

const CHAIN_TX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Returns true when a fatal claim error actually indicates the score was
 * already submitted on-chain by a prior attempt. The contract rejects
 * duplicate journals ("already claimed") and non-improving scores ("score not
 * improved"), both of which prove the claim landed previously.
 */
function isAlreadyClaimedOnChain(message: string, errorDetail?: string): boolean {
  const combined = (message + " " + (errorDetail ?? "")).toLowerCase();
  return (
    combined.includes("already claimed") ||
    combined.includes("journalalreadyclaimed") ||
    combined.includes("score not improved") ||
    combined.includes("scorenotimproved") ||
    /contract,\s*#(?:3|5)\b/.test(combined) // #3 JournalAlreadyClaimed, #5 ScoreNotImproved
  );
}

function journalRawHex(journal: ProofJournal): string {
  return Array.from(packJournalRaw(journal))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readSupersedeInputs(job: ProofJobRecord): {
  claimantAddress: string;
  seedId: number;
  score: number;
} | null {
  const claimantAddress = job.claim?.claimantAddress;
  if (typeof claimantAddress !== "string" || claimantAddress.length === 0) {
    return null;
  }

  const seedId = job.tape?.metadata?.seedId;
  const score = job.tape?.metadata?.finalScore;
  if (
    typeof seedId !== "number" ||
    !Number.isFinite(seedId) ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) {
    return null;
  }

  return {
    claimantAddress,
    seedId: seedId >>> 0,
    score: score >>> 0,
  };
}

async function persistClaimReplayIndexes(
  env: WorkerEnv,
  job: Pick<
    ProofJobRecord,
    "jobId" | "tape" | "claim" | "result" | "completedAt" | "updatedAt" | "createdAt"
  >,
  txHash: string,
): Promise<void> {
  if (!CHAIN_TX_HASH_RE.test(txHash)) {
    return;
  }

  const claimantAddress = job.result?.summary?.journal.claimant ?? job.claim.claimantAddress;
  await writeProofClaimIndexEntry(env, {
    proofJobId: job.jobId,
    claimantAddress,
    txHash,
    seed: job.tape.metadata.seed,
    finalScore: job.tape.metadata.finalScore,
    completedAt: job.completedAt ?? job.updatedAt ?? job.createdAt,
  });
  await writeProofTapeMapping(env, txHash, job.jobId);
}

async function findSupersedingClaimedJob(
  coordinator: ReturnType<typeof coordinatorStub>,
  job: ProofJobRecord,
): Promise<ProofJobRecord | null> {
  const inputs = readSupersedeInputs(job);
  if (!inputs) {
    return null;
  }

  const { jobs: claimantJobs } = await coordinator.listJobsForClaimant(
    inputs.claimantAddress,
    100,
    0,
  );
  let winner: ProofJobRecord | null = null;
  for (const candidate of claimantJobs) {
    if (candidate.jobId === job.jobId) continue;
    const candidateSeedIdRaw = candidate.tape?.metadata?.seedId;
    if (typeof candidateSeedIdRaw !== "number" || !Number.isFinite(candidateSeedIdRaw)) continue;
    const candidateSeedId = candidateSeedIdRaw >>> 0;
    if (candidateSeedId !== inputs.seedId) continue;
    if (candidate.claim?.status !== "succeeded") continue;
    const candidateScoreRaw = candidate.tape?.metadata?.finalScore;
    if (typeof candidateScoreRaw !== "number" || !Number.isFinite(candidateScoreRaw)) continue;
    const candidateScore = candidateScoreRaw >>> 0;
    if (candidateScore < inputs.score) continue;
    const winnerScoreRaw = winner?.tape?.metadata?.finalScore;
    const winnerScore =
      typeof winnerScoreRaw === "number" && Number.isFinite(winnerScoreRaw)
        ? winnerScoreRaw >>> 0
        : -1;
    if (!winner || candidateScore > winnerScore) {
      winner = candidate;
    }
  }

  return winner;
}

async function maybeSkipSupersededProofSubmission(
  coordinator: ReturnType<typeof coordinatorStub>,
  jobId: string,
  job: ProofJobRecord,
  message: Message<ProofQueueMessage>,
): Promise<boolean> {
  const inputs = readSupersedeInputs(job);
  if (!inputs) {
    return false;
  }

  let supersedingJob: ProofJobRecord | null = null;
  try {
    supersedingJob = await findSupersedingClaimedJob(coordinator, job);
  } catch (error) {
    console.warn(
      `[proof-queue] failed supersede precheck for ${jobId}: ${safeErrorMessage(error)}`,
    );
    return false;
  }

  if (!supersedingJob) {
    return false;
  }

  const winnerScoreRaw = supersedingJob.tape?.metadata?.finalScore;
  const winnerScore =
    typeof winnerScoreRaw === "number" && Number.isFinite(winnerScoreRaw)
      ? winnerScoreRaw >>> 0
      : 0;
  console.log("[proof-queue] skipping prover submission — superseded by claimed score", {
    jobId,
    seedId: inputs.seedId,
    score: inputs.score,
    supersedingJobId: supersedingJob.jobId,
    supersedingScore: winnerScore,
  });
  await coordinator.markFailed(
    jobId,
    `proof skipped: superseded by claimed score ${winnerScore} for seed_id ${inputs.seedId}`,
    {
      errorCode: "superseded_by_higher_score",
    },
  );
  message.ack();
  return true;
}

// ---------------------------------------------------------------------------
// Shared pre-submission checks
// ---------------------------------------------------------------------------

interface PreparedJob {
  jobId: string;
  job: ProofJobRecord;
  tapeBytes: Uint8Array;
}

function resolveMaxProofTotalWallTimeMs(env: WorkerEnv): number {
  return parseInteger(
    env.MAX_PROOF_TOTAL_WALL_TIME_MS,
    DEFAULT_MAX_PROOF_TOTAL_WALL_TIME_MS,
    60_000,
  );
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
  const maxWallTimeMs = resolveMaxProofTotalWallTimeMs(env);

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

  if (await maybeSkipSupersededProofSubmission(coordinator, jobId, startedJob, message)) {
    return null;
  }

  const jobAgeMs = Date.now() - new Date(startedJob.createdAt).getTime();
  if (jobAgeMs > maxWallTimeMs) {
    const ageMin = Math.round(jobAgeMs / 60_000);
    await coordinator.markFailed(
      jobId,
      `proof job timed out after ${ageMin} minutes (attempt ${message.attempts})`,
      {
        errorCode: "job_total_wall_timeout",
        timeoutPhase: "total_wall",
      },
    );
    message.ack();
    return null;
  }

  // Retry the R2 read a few times before giving up — a transient consistency
  // delay has caused tape-not-found failures in production even though the
  // API handler confirmed the put.
  const TAPE_READ_MAX_ATTEMPTS = 3;
  const TAPE_READ_RETRY_DELAY_MS = 1_000;
  let tapeObject: R2ObjectBody | null = null;

  for (let attempt = 1; attempt <= TAPE_READ_MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    tapeObject = await env.PROOF_ARTIFACTS.get(startedJob.tape.key);
    if (tapeObject) break;
    if (attempt < TAPE_READ_MAX_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, TAPE_READ_RETRY_DELAY_MS));
    }
  }

  if (!tapeObject) {
    await coordinator.markFailed(
      jobId,
      `missing tape artifact in R2 after ${TAPE_READ_MAX_ATTEMPTS} attempts`,
    );
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
  backend: ProverBackend,
  message: Message<ProofQueueMessage>,
  env: WorkerEnv,
  maxRetries: number,
): Promise<void> {
  const coordinator = coordinatorStub(env);

  if (submitResult.type === "retry") {
    if (message.attempts >= maxRetries) {
      await coordinator.markDispatchFailedAndTryNextBackend(
        jobId,
        backend,
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
    await coordinator.markDispatchFailedAndTryNextBackend(jobId, backend, submitResult.message);
    message.ack();
    return;
  }

  // Submission succeeded — markProverAccepted sets the first alarm for polling.
  await coordinator.markProverAccepted(
    jobId,
    submitResult.jobId,
    submitResult.statusUrl,
    submitResult.segmentLimitPo2,
    submitResult.ipfsCid,
    submitResult.maxPriceUsd,
    submitResult.minPriceWei,
    submitResult.maxPriceWei,
    submitResult.fundingModeUsed,
    submitResult.marketBalanceBeforeWei,
    submitResult.autoDepositWei,
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
    // but if it does, immediately fail over to the next backend.
    await coordinator.markDispatchFailedAndTryNextBackend(
      jobId,
      "boundless",
      "boundless backend not configured",
    );
    message.ack();
    return;
  }

  let submitResult: Awaited<ReturnType<BoundlessClient["submitRequest"]>>;
  try {
    submitResult = await new BoundlessClient(boundlessConfig).submitRequest(tapeBytes, {
      seedId: prepared.job.tape.metadata.seedId >>> 0,
      claimantAddress: prepared.job.claim.claimantAddress,
    });
  } catch (error) {
    const reason = `boundless submit error: ${safeErrorMessage(error)}`;
    if (message.attempts >= MAX_QUEUE_RETRIES) {
      await coordinator.markDispatchFailedAndTryNextBackend(
        jobId,
        "boundless",
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

  await handleSubmitResult(submitResult, jobId, "boundless", message, env, MAX_QUEUE_RETRIES);
}

// ---------------------------------------------------------------------------
// VastAI queue consumer (VAST_QUEUE — serial, 1-at-a-time)
// ---------------------------------------------------------------------------

/**
 * Attempt to recover a stale VastAI slot by kicking the coordinator alarm.
 * kickAlarm() applies wall-time, Boundless, and Vast prover run timeouts
 * directly, so a single call handles all recovery paths.
 */
async function tryRecoverStaleVastSlot(
  coordinator: ReturnType<typeof coordinatorStub>,
): Promise<boolean> {
  const activeVastJob = await coordinator.getActiveVastJob();
  if (
    !activeVastJob ||
    isTerminalProofStatus(activeVastJob.status) ||
    !activeVastJob.prover.jobId
  ) {
    return false;
  }

  await coordinator.kickAlarm();

  // Re-check: kickAlarm may have timed out or recovered the job.
  return !(await coordinator.hasActiveVastJob());
}

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
  let slotBusy = await coordinator.hasActiveVastJob();
  if (slotBusy) {
    try {
      await tryRecoverStaleVastSlot(coordinator);
      slotBusy = await coordinator.hasActiveVastJob();
    } catch (error) {
      console.warn(`[vast-queue] stale slot recovery failed: ${safeErrorMessage(error)}`);
      slotBusy = await coordinator.hasActiveVastJob();
    }
  }
  if (slotBusy) {
    const job = await coordinator.getJob(payload.jobId);
    if (!job || isTerminalProofStatus(job.status)) {
      message.ack();
      return;
    }

    if (await maybeSkipSupersededProofSubmission(coordinator, payload.jobId, job, message)) {
      return;
    }

    const maxWallTimeMs = resolveMaxProofTotalWallTimeMs(env);
    const jobAgeMs = Date.now() - new Date(job.createdAt).getTime();
    if (jobAgeMs > maxWallTimeMs) {
      const ageMin = Math.round(jobAgeMs / 60_000);
      await coordinator.markFailed(
        payload.jobId,
        `proof job timed out after ${ageMin} minutes while waiting for vast slot`,
        {
          errorCode: "vast_slot_wait_timeout",
          timeoutPhase: "vast_wait",
        },
      );
      message.ack();
      return;
    }

    const reason = "vast slot busy; waiting for active prover job to finish";
    const nextRetryAt = new Date(
      Date.now() + VAST_SLOT_BUSY_RETRY_DELAY_SECONDS * 1000,
    ).toISOString();
    await coordinator.markRetry(payload.jobId, reason, nextRetryAt);

    if (message.attempts >= MAX_VAST_QUEUE_RETRIES) {
      // Reset queue delivery attempts while keeping the same job state.
      try {
        await env.VAST_QUEUE.send(
          { jobId: payload.jobId },
          {
            contentType: "json",
            delaySeconds: VAST_SLOT_BUSY_RETRY_DELAY_SECONDS,
          },
        );
        message.ack();
      } catch (error) {
        await coordinator.markFailed(
          payload.jobId,
          `failed re-enqueueing vast slot wait: ${safeErrorMessage(error)}`,
        );
        message.ack();
      }
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
    submitResult = await submitToProver(env, tapeBytes, {
      seedId: prepared.job.tape.metadata.seedId >>> 0,
      claimantAddress: prepared.job.claim.claimantAddress,
    });
  } catch (error) {
    const reason = `vast submit error: ${safeErrorMessage(error)}`;
    if (message.attempts >= MAX_VAST_QUEUE_RETRIES) {
      await coordinator.markDispatchFailedAndTryNextBackend(
        jobId,
        "vast",
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

  await handleSubmitResult(submitResult, jobId, "vast", message, env, MAX_VAST_QUEUE_RETRIES);
}

// ---------------------------------------------------------------------------
// Claim queue
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
    if (CHAIN_TX_HASH_RE.test(job.claim.txHash ?? "")) {
      try {
        await persistClaimReplayIndexes(env, job, job.claim.txHash as string);
      } catch (error) {
        console.error("[claim-queue] failed healing replay indexes for succeeded claim", error);
        if (message.attempts < MAX_QUEUE_RETRIES) {
          const delaySeconds = retryDelaySeconds(message.attempts);
          message.retry({ delaySeconds });
          return;
        }
      }
    }
    message.ack();
    return;
  }

  if (!job.result?.summary || !job.result?.artifactKey) {
    await coordinator.markClaimFailed(payload.jobId, "missing proof result for claim submission");
    message.ack();
    return;
  }

  // Skip claim if a higher-scoring proof already claimed successfully for this
  // claimant. This prevents the contract rejection in common serial-race cases.
  const thisScore = job.tape.metadata.finalScore >>> 0;
  const thisSeedId = job.tape.metadata.seedId >>> 0;
  const canonicalClaimant = job.result.summary.journal.claimant;
  const { jobs: claimantJobs } = await coordinator.listJobsForClaimant(canonicalClaimant, 100, 0);
  const superseded = claimantJobs.some(
    (j) =>
      j.jobId !== job.jobId &&
      j.tape.metadata.seedId >>> 0 === thisSeedId && // same seed_id only
      j.claim.status === "succeeded" &&
      j.tape.metadata.finalScore >>> 0 >= thisScore,
  );
  if (superseded) {
    console.log("[claim-queue] skipping — superseded by higher-scoring claim", {
      jobId: payload.jobId,
      score: thisScore,
    });
    await coordinator.markClaimSucceeded(payload.jobId, "superseded-by-higher-score");
    message.ack();
    return;
  }

  const artifact = await env.PROOF_ARTIFACTS.get(job.result.artifactKey);
  if (!artifact) {
    await coordinator.markClaimFailed(payload.jobId, "missing proof artifact in R2");
    message.ack();
    return;
  }

  let artifactJson: unknown;
  try {
    artifactJson = (await artifact.json()) as unknown;
  } catch (error) {
    await coordinator.markClaimFailed(
      payload.jobId,
      `failed parsing proof artifact json: ${safeErrorMessage(error)}`,
    );
    message.ack();
    return;
  }

  let parsedArtifact;
  try {
    parsedArtifact = parseProofArtifactV4(artifactJson);
  } catch (error) {
    await coordinator.markClaimFailed(
      payload.jobId,
      `invalid proof artifact payload: ${safeErrorMessage(error)}`,
    );
    message.ack();
    return;
  }

  const expectedJournalHex = journalRawHex(job.result.summary.journal);
  if (parsedArtifact.journal_raw_hex !== expectedJournalHex) {
    await coordinator.markClaimFailed(
      payload.jobId,
      "proof artifact journal_raw_hex does not match coordinator summary",
    );
    message.ack();
    return;
  }

  const computedDigestHex = await sha256Hex(
    hexToBytes(parsedArtifact.journal_raw_hex, "journal_raw_hex"),
  );
  if (computedDigestHex !== parsedArtifact.journal_digest_hex) {
    await coordinator.markClaimFailed(
      payload.jobId,
      "proof artifact journal_digest_hex does not match journal_raw_hex",
    );
    message.ack();
    return;
  }

  let relayResult: Awaited<ReturnType<typeof submitClaim>>;
  try {
    relayResult = await submitClaim(env, {
      jobId: payload.jobId,
      journalRawHex: parsedArtifact.journal_raw_hex,
      journalDigestHex: parsedArtifact.journal_digest_hex,
      sealHex: parsedArtifact.seal_hex,
    });
  } catch (error) {
    const reason = `claim submit error: ${safeErrorMessage(error)}`;
    const crashDetail = error instanceof Error ? (error.stack ?? error.message) : String(error);
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
    if (CHAIN_TX_HASH_RE.test(relayResult.txHash)) {
      try {
        await persistClaimReplayIndexes(
          env,
          {
            ...job,
            claim: {
              ...job.claim,
              claimantAddress: canonicalClaimant,
              txHash: relayResult.txHash,
            },
          },
          relayResult.txHash,
        );
      } catch (error) {
        console.error(
          "[claim-queue] failed persisting replay indexes after successful claim",
          error,
        );
        if (message.attempts < MAX_QUEUE_RETRIES) {
          const delaySeconds = retryDelaySeconds(message.attempts);
          message.retry({ delaySeconds });
          return;
        }
      }
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
  if (isAlreadyClaimedOnChain(relayResult.message, relayResult.errorDetail)) {
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
      const crashDetail = error instanceof Error ? (error.stack ?? error.message) : String(error);
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
    const priorErrorDetail =
      // eslint-disable-next-line unicorn/no-array-reverse -- toReversed unavailable in worker lib target
      [...(job?.claimAttempts ?? [])].reverse().find((a) => a.errorDetail != null)?.errorDetail ??
      "";

    // If the last error indicates the claim already landed on-chain via a
    // prior attempt, treat this as success rather than failure.
    if (priorError.length > 0 && isAlreadyClaimedOnChain(priorError, priorErrorDetail)) {
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
