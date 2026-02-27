import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import {
  ChannelsClient,
  PluginExecutionError,
  PluginTransportError,
} from "@openzeppelin/relayer-plugin-channels/dist/client";
import {
  DEFAULT_BINDINGS_RPC_URL,
  DEFAULT_RELAYER_REQUEST_TIMEOUT_MS,
  OPENZEPPELIN_CHANNELS_HOSTNAME,
} from "../constants";
import type { WorkerEnv } from "../env";
import { parseInteger, safeErrorMessage } from "../utils";
import type { RelayClaimRequest, RelaySubmitResult } from "./types";

interface ChannelsConfig {
  baseUrl: string;
  apiKey: string;
  pluginId: string | null;
  timeoutMs: number;
}

interface DirectClaimConfig {
  scoreContractId: string;
  channels: ChannelsConfig;
}

const SEED_INTERVAL_SECONDS = 600;
const SEED_REFRESH_COOLDOWN_MS = 2_500;
const SEED_REFRESH_RECHECK_DELAYS_MS = [500, 1_000, 1_500] as const;

let inFlightSeedEnsureSeedId: number | null = null;
let inFlightSeedEnsurePromise: Promise<EnsureCurrentEpochSeedResult> | null = null;
let lastSeedRefreshAttemptSeedId: number | null = null;
let lastSeedRefreshAttemptAt = 0;

function isAcceptedWithoutHashMessage(message: string | null | undefined): boolean {
  return (message ?? "").toLowerCase().includes("did not return hash");
}

function nonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveChannelsConfig(env: WorkerEnv): ChannelsConfig | null {
  const relayUrlRaw = nonEmpty(env.RELAYER_URL);
  const apiKey = nonEmpty(env.RELAYER_API_KEY);
  if (!relayUrlRaw || !apiKey) {
    return null;
  }

  let relayUrl: URL;
  try {
    relayUrl = new URL(relayUrlRaw);
  } catch {
    return null;
  }

  const pluginId = nonEmpty(env.RELAYER_PLUGIN_ID);
  const isManagedChannels = relayUrl.hostname
    .toLowerCase()
    .includes(OPENZEPPELIN_CHANNELS_HOSTNAME);
  if (!isManagedChannels && !pluginId) {
    return null;
  }

  const normalizedPath = relayUrl.pathname.replace(/\/+$/g, "");
  relayUrl.pathname = normalizedPath.length > 0 ? normalizedPath : "/";

  return {
    baseUrl: relayUrl.toString(),
    apiKey,
    pluginId,
    timeoutMs: parseInteger(
      env.RELAYER_REQUEST_TIMEOUT_MS,
      DEFAULT_RELAYER_REQUEST_TIMEOUT_MS,
      1_000,
    ),
  };
}

export function resolveDirectClaimConfig(env: WorkerEnv): DirectClaimConfig | null {
  const scoreContractId = nonEmpty(env.SCORE_CONTRACT_ID);
  const channels = resolveChannelsConfig(env);
  if (!scoreContractId || !channels) {
    return null;
  }

  return {
    scoreContractId,
    channels,
  };
}

export function isDirectClaimConfigured(env: WorkerEnv): boolean {
  return resolveDirectClaimConfig(env) !== null;
}

function resolveBindingsRpcUrl(env: WorkerEnv): string {
  return nonEmpty(env.STELLAR_RPC_URL) ?? DEFAULT_BINDINGS_RPC_URL;
}

function hexToBytes(hex: string, fieldName: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid even-length hex string`);
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asByte(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error(`${fieldName}[${index}] must be a byte`);
  }
  return value & 0xff;
}

function asU32(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${fieldName}[${index}] must be a u32`);
  }
  return value >>> 0;
}

function extractGroth16SealFromProverResponse(proverResponse: unknown): Uint8Array {
  const responseObj = asObject(proverResponse);
  const resultObj = responseObj ? asObject(responseObj.result) : null;
  const proofObj = resultObj ? asObject(resultObj.proof) : null;
  const receiptObj = proofObj ? asObject(proofObj.receipt) : null;
  const innerObj = receiptObj ? asObject(receiptObj.inner) : null;
  const groth16 = innerObj ? asObject(innerObj.Groth16) : null;

  if (!groth16) {
    throw new Error("prover_response.result.proof.receipt.inner.Groth16 is required");
  }

  const seal = groth16.seal;
  const verifierParameters = groth16.verifier_parameters;
  if (!Array.isArray(seal) || seal.length !== 256) {
    throw new Error("receipt.inner.Groth16.seal must be a 256-byte array");
  }
  if (!Array.isArray(verifierParameters) || verifierParameters.length !== 8) {
    throw new Error("receipt.inner.Groth16.verifier_parameters must be an 8-word array");
  }

  const rawSeal = Uint8Array.from(
    seal.map((value, index) => asByte(value, "receipt.inner.Groth16.seal", index)),
  );
  const params = verifierParameters.map((value, index) =>
    asU32(value, "receipt.inner.Groth16.verifier_parameters", index),
  );

  const paramsBytes = new Uint8Array(32);
  const paramsView = new DataView(paramsBytes.buffer);
  for (let index = 0; index < params.length; index += 1) {
    paramsView.setUint32(index * 4, params[index], true);
  }

  const selector = paramsBytes.slice(0, 4);
  const stellarSeal = new Uint8Array(260);
  stellarSeal.set(selector, 0);
  stellarSeal.set(rawSeal, 4);
  return stellarSeal;
}

interface SorobanInvokePayload {
  func: string;
  auth: string[];
}

export type RelayProxyPayload =
  | {
      kind: "xdr";
      xdr: string;
    }
  | {
      kind: "soroban";
      func: string;
      auth: string[];
    };

function retryableChannelsExecutionCode(rawCode: string | null): boolean {
  if (!rawCode) {
    return false;
  }
  const code = rawCode.toLowerCase();
  return (
    code === "pool_capacity" ||
    code === "rate_limit" ||
    code === "locked_conflict" ||
    code === "service_unavailable"
  );
}

function extractExecutionCode(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }
  const code = (details as Record<string, unknown>).code;
  if (typeof code === "string" && code.trim().length > 0) {
    return code.trim();
  }
  return null;
}

/**
 * Extract a Soroban contract error number from SIMULATION_FAILED errorDetails.
 * Channels surfaces these as e.g. "escalating Ok(ScErrorType::Contract) frame-exit to Err (Contract, #3)".
 */
function extractContractErrorCode(errorDetails: unknown): number | null {
  const details = asObject(errorDetails);
  const inner = details ? asObject(details.details) : null;
  const errorStr = inner && typeof inner.error === "string" ? inner.error : null;
  if (!errorStr) return null;
  const match = /\(Contract,\s*#(\d+)\)/.exec(errorStr);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Map a known asteroids-score contract error code to an appropriate RelaySubmitResult.
 *
 * Error codes (from lib.rs #[contracterror]):
 *   1 InvalidJournalFormat  — journal is malformed                → fatal
 *   2 InvalidRulesDigest    — wrong rules digest / image id       → fatal
 *   3 JournalAlreadyClaimed — digest already on-chain             → treat as prior success
 *   4 ZeroScoreNotAllowed   — score is 0                          → fatal
 *   5 ScoreNotImproved      — not better than existing best       → treat as superseded
 *   6 ContractPaused        — contract is paused (admin action)   → fatal
 *   7 SeedNotActive         — seed missing/expired/future         → fatal
 */
function classifySimulationContractError(
  contractCode: number,
  errorDetails: unknown,
): RelaySubmitResult {
  const errorDetail = buildErrorDetail({ errorDetails });
  switch (contractCode) {
    case 1:
      return {
        type: "fatal",
        message: "claim rejected: journal data is malformed (InvalidJournalFormat)",
        errorDetail,
      };
    case 2:
      return {
        type: "fatal",
        message: "claim rejected: proof rules digest does not match contract (InvalidRulesDigest)",
        errorDetail,
      };
    case 3:
      // Journal digest already exists on-chain — a prior claim attempt succeeded.
      return { type: "success", txHash: "prior-attempt" };
    case 4:
      return {
        type: "fatal",
        message: "claim rejected: score is zero (ZeroScoreNotAllowed)",
        errorDetail,
      };
    case 5:
      // Score did not beat claimant's current best — superseded by a higher score.
      return { type: "success", txHash: "superseded-by-higher-score" };
    case 6:
      return {
        type: "fatal",
        message: "claim rejected: contract is paused (ContractPaused)",
        errorDetail,
      };
    case 7:
      return {
        type: "fatal",
        message: "claim rejected: seed is not active for this seed_id (SeedNotActive)",
        errorDetail,
      };
    default:
      return {
        type: "fatal",
        message: `claim rejected: contract error #${contractCode}`,
        errorDetail,
      };
  }
}

/** Deterministic contract / input patterns that should never be retried. */
function hasFatalClaimIndicator(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("error(contract") ||
    m.includes("hosterror") ||
    m.includes("missing proof") ||
    m.includes("required") ||
    m.includes("must be a valid") ||
    m.includes("score not improved") ||
    m.includes("already claimed")
  );
}

function isRetryableChannelsExecution(message: string, code: string | null): boolean {
  // SIMULATION_FAILED is handled via extractContractErrorCode before reaching here;
  // this branch is a fallback for opaque simulation failures with no contract code.
  if (code?.toLowerCase() === "simulation_failed") {
    if (hasFatalClaimIndicator(message)) {
      return false;
    }
    return isRetryableDirectClaimMessage(message);
  }

  if (retryableChannelsExecutionCode(code)) {
    return true;
  }
  // The error code itself may be a known network/transient error (e.g. ECONNRESET).
  if (code && isRetryableDirectClaimMessage(code)) {
    return true;
  }
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("internal error") && normalized.includes("reference")) ||
    normalized.includes("too many transactions queued") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later") ||
    isRetryableDirectClaimMessage(message)
  );
}

function buildChannelsClient(config: ChannelsConfig): ChannelsClient {
  if (config.pluginId) {
    return new ChannelsClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      pluginId: config.pluginId,
      timeout: config.timeoutMs,
    });
  }

  return new ChannelsClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
  });
}

export function isRetryableDirectClaimMessage(rawMessage: string): boolean {
  const message = rawMessage.toLowerCase();

  if (hasFatalClaimIndicator(message)) {
    return false;
  }

  return (
    message.includes("network connection lost") ||
    message.includes("failed to fetch") ||
    (message.includes("internal error") && message.includes("reference")) ||
    message.includes("reference =") ||
    message.includes("network error") ||
    message.includes("networkerror") ||
    message.includes("connection lost") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("socket hang up") ||
    message.includes("temporarily unavailable") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("try again later") ||
    message.includes("http 429") ||
    message.includes("http 500") ||
    message.includes("http 502") ||
    message.includes("http 503") ||
    message.includes("http 504")
  );
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildErrorDetail(parts: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(parts)) {
    if (value == null) continue;
    const str = typeof value === "string" ? value : safeJsonStringify(value) ?? String(value);
    if (str.length > 0) lines.push(`${key}: ${str}`);
  }
  return lines.join("\n");
}

async function submitSorobanOperationViaChannels(
  config: ChannelsConfig,
  payload: SorobanInvokePayload,
): Promise<RelaySubmitResult> {
  const client = buildChannelsClient(config);

  try {
    const result = await client.submitSorobanTransaction(payload);

    const txHash = result.hash?.trim() ?? "";
    const status = result.status?.trim().toLowerCase() ?? "";
    if (txHash.length === 0) {
      return {
        type: status === "failed" || status === "error" ? "fatal" : "retry",
        message: "channels relayer accepted soroban transaction but did not return hash",
      };
    }

    return {
      type: "success",
      txHash,
    };
  } catch (error) {
    if (error instanceof PluginTransportError) {
      return {
        type: "retry",
        message: `channels relayer transport failed: ${error.message}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          statusCode: error.statusCode,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    if (error instanceof PluginExecutionError) {
      const code = extractExecutionCode(error.errorDetails);

      // For SIMULATION_FAILED, parse the Soroban contract error code first so
      // we can give each outcome a precise classification and message.
      if (code?.toLowerCase() === "simulation_failed") {
        const contractCode = extractContractErrorCode(error.errorDetails);
        if (contractCode !== null) {
          return classifySimulationContractError(contractCode, error.errorDetails);
        }
        // Opaque simulation failure — no contract error code found.
        const isRetryable = !hasFatalClaimIndicator(error.message) &&
          isRetryableDirectClaimMessage(error.message);
        return {
          type: isRetryable ? "retry" : "fatal",
          message: `soroban simulation failed: ${error.message}`,
          errorDetail: buildErrorDetail({
            category: error.category,
            code,
            message: error.message,
            errorDetails: error.errorDetails,
            stack: error.stack,
          }),
        };
      }

      const detail = code ? `${error.message} (${code})` : error.message;
      return {
        type: isRetryableChannelsExecution(error.message, code) ? "retry" : "fatal",
        message: `channels relayer soroban submission failed: ${detail}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          code,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    const detail = safeErrorMessage(error);
    return {
      type: isRetryableDirectClaimMessage(detail) ? "retry" : "fatal",
      message: `channels relayer soroban submission failed: ${detail}`,
      errorDetail: buildErrorDetail({
        message: detail,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    };
  }
}

async function submitSignedTransactionViaChannels(
  config: ChannelsConfig,
  signedXdr: string,
): Promise<RelaySubmitResult> {
  const client = buildChannelsClient(config);

  try {
    const result = await client.submitTransaction({ xdr: signedXdr });

    const txHash = result.hash?.trim() ?? "";
    const status = result.status?.trim().toLowerCase() ?? "";
    if (txHash.length === 0) {
      return {
        type: status === "failed" || status === "error" ? "fatal" : "retry",
        message: "channels relayer accepted signed transaction but did not return hash",
      };
    }

    return {
      type: "success",
      txHash,
    };
  } catch (error) {
    if (error instanceof PluginTransportError) {
      return {
        type: "retry",
        message: `channels relayer transport failed: ${error.message}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          statusCode: error.statusCode,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    if (error instanceof PluginExecutionError) {
      const code = extractExecutionCode(error.errorDetails);
      const detail = code ? `${error.message} (${code})` : error.message;
      return {
        type: isRetryableChannelsExecution(error.message, code) ? "retry" : "fatal",
        message: `channels relayer signed transaction submission failed: ${detail}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          code,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    const detail = safeErrorMessage(error);
    return {
      type: isRetryableDirectClaimMessage(detail) ? "retry" : "fatal",
      message: `channels relayer signed transaction submission failed: ${detail}`,
      errorDetail: buildErrorDetail({
        message: detail,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    };
  }
}

export async function submitRelayProxy(
  env: WorkerEnv,
  payload: RelayProxyPayload,
): Promise<RelaySubmitResult> {
  const channels = resolveChannelsConfig(env);
  if (!channels) {
    return {
      type: "fatal",
      message: "relayer is not configured; set RELAYER_URL and RELAYER_API_KEY",
    };
  }

  if (payload.kind === "xdr") {
    return submitSignedTransactionViaChannels(channels, payload.xdr);
  }

  return submitSorobanOperationViaChannels(channels, {
    func: payload.func,
    auth: payload.auth,
  });
}

async function buildSubmitScorePayloadViaBindings(
  scoreContractId: string,
  seal: Uint8Array,
  journalRaw: Uint8Array,
): Promise<SorobanInvokePayload> {
  return buildInvokePayloadForContractFn(
    scoreContractId,
    "submit_score",
    [xdr.ScVal.scvBytes(Buffer.from(seal)), xdr.ScVal.scvBytes(Buffer.from(journalRaw))],
  );
}

function buildCurrentSeedPayload(scoreContractId: string): SorobanInvokePayload {
  return buildInvokePayloadForContractFn(scoreContractId, "current_seed", []);
}

function buildInvokePayloadForContractFn(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
): SorobanInvokePayload {
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contractId).toScAddress(),
    functionName: fnName,
    args,
  });
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  return {
    func: hostFn.toXDR("base64"),
    auth: [],
  };
}

async function fetchSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<number | null> {
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http:"),
  });
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SeedById"), xdr.ScVal.scvU32(seedId)]);

  try {
    const entry = await server.getContractData(contractId, key, rpc.Durability.Temporary);
    const value = entry.val.contractData().val();
    if (value.switch().name !== "scvU32") {
      return null;
    }
    return value.u32() >>> 0;
  } catch {
    return null;
  }
}

function currentSeedIdWithSecondsLeft(nowMs: number = Date.now()): {
  seedId: number;
  secondsLeft: number;
} {
  const epochMs = SEED_INTERVAL_SECONDS * 1000;
  const seedId = Math.floor(nowMs / epochMs);
  const secondsLeft = Math.ceil((epochMs - (nowMs % epochMs)) / 1000);
  return { seedId, secondsLeft };
}

export interface CurrentEpochSeedState {
  seedId: number;
  secondsLeft: number;
  materializedSeed: number | null;
  activeSeed: number | null;
}

export interface SeedRefreshResult {
  success: boolean;
  message: string | null;
  seedId: number | null;
  seed: number | null;
  txHashCurrentSeed: string | null;
}

export interface EnsureCurrentEpochSeedResult {
  success: boolean;
  state: CurrentEpochSeedState;
  refreshAttempted: boolean;
  refreshed: boolean;
  message: string | null;
  txHashCurrentSeed: string | null;
  retryAfterSeconds?: number;
}

export async function readCurrentEpochSeedState(env: WorkerEnv): Promise<CurrentEpochSeedState> {
  const scoreContractId = nonEmpty(env.SCORE_CONTRACT_ID);
  if (!scoreContractId) {
    throw new Error("SCORE_CONTRACT_ID is not configured");
  }

  const rpcUrl = resolveBindingsRpcUrl(env);
  const { seedId, secondsLeft } = currentSeedIdWithSecondsLeft();
  const materializedSeed = await fetchSeedById(scoreContractId, rpcUrl, seedId);
  return {
    seedId,
    secondsLeft,
    materializedSeed: materializedSeed ?? null,
    activeSeed: materializedSeed ?? null,
  };
}

export async function submitSeedRefresh(env: WorkerEnv): Promise<SeedRefreshResult> {
  const config = resolveDirectClaimConfig(env);
  if (!config) {
    console.log("[seed-refresh] channels relayer not configured, skipping seed refresh");
    return {
      success: false,
      message: "channels relayer not configured",
      seedId: null,
      seed: null,
      txHashCurrentSeed: null,
    };
  }

  const rpcUrl = resolveBindingsRpcUrl(env);
  let phase = "init";
  try {
    phase = "build_payload_current_seed";
    const payload = buildCurrentSeedPayload(config.scoreContractId);

    console.log("[seed-refresh] submitting current_seed() to materialize current seed_id", {
      contractId: config.scoreContractId,
      relayerUrl: config.channels.baseUrl,
    });

    phase = "send_tx_current_seed";
    const result = await submitSorobanOperationViaChannels(config.channels, payload);
    let txHashCurrentSeed: string | null = null;
    const currentSeedAcceptedWithoutHash = result.type === "retry" &&
      isAcceptedWithoutHashMessage(result.message);
    if (result.type === "success") {
      txHashCurrentSeed = result.txHash;
    } else if (!currentSeedAcceptedWithoutHash) {
      console.warn("[seed-refresh] seed materialization failed", {
        type: result.type,
        message: result.message,
      });
      return {
        success: false,
        message: result.message,
        seedId: null,
        seed: null,
        txHashCurrentSeed: txHashCurrentSeed,
      };
    }
    if (currentSeedAcceptedWithoutHash) {
      console.warn("[seed-refresh] current_seed accepted without hash; verifying chain state", {
        message: result.message,
      });
    }

    const nowSeedId = Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
    const candidateSeedIds = nowSeedId > 0 ? [nowSeedId, nowSeedId - 1] : [nowSeedId];

    phase = "fetch_seed_by_id";
    let seedId: number | null = null;
    let seed: number | null = null;
    const materializationReadDelaysMs = currentSeedAcceptedWithoutHash ? [0, 600, 1_500, 3_000] : [0];
    for (const delayMs of materializationReadDelaysMs) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      for (const candidateSeedId of candidateSeedIds) {
        const candidateSeed = await fetchSeedById(config.scoreContractId, rpcUrl, candidateSeedId);
        if (candidateSeed !== null) {
          seedId = candidateSeedId;
          seed = candidateSeed;
          break;
        }
      }
      if (seedId !== null && seed !== null) {
        break;
      }
    }

    if (seedId === null || seed === null) {
      console.warn("[seed-refresh] unable to read SeedById(seed_id) after materialization", {
        triedSeedIds: candidateSeedIds,
      });
      return {
        success: false,
        message: "could not read SeedById(seed_id) after materialization",
        seedId: null,
        seed: null,
        txHashCurrentSeed: txHashCurrentSeed,
      };
    }

    console.log("[seed-refresh] seed materialized successfully", {
      seedId,
      seed,
      txHashCurrentSeed,
    });
    return {
      success: true,
      message: null,
      seedId,
      seed,
      txHashCurrentSeed,
    };
  } catch (error) {
    const detail = safeErrorMessage(error);
    console.error(`[seed-refresh] error during ${phase}: ${detail}`);
    return {
      success: false,
      message: detail,
      seedId: null,
      seed: null,
      txHashCurrentSeed: null,
    };
  }
}

export async function ensureCurrentEpochSeed(env: WorkerEnv): Promise<EnsureCurrentEpochSeedResult> {
  let state = await readCurrentEpochSeedState(env);
  if (state.activeSeed !== null) {
    return {
      success: true,
      state,
      refreshAttempted: false,
      refreshed: false,
      message: "current epoch seed is already indexed",
      txHashCurrentSeed: null,
    };
  }

  const seedId = state.seedId;
  if (inFlightSeedEnsurePromise && inFlightSeedEnsureSeedId === seedId) {
    return inFlightSeedEnsurePromise;
  }

  const now = Date.now();
  if (
    lastSeedRefreshAttemptSeedId === seedId &&
    now - lastSeedRefreshAttemptAt < SEED_REFRESH_COOLDOWN_MS
  ) {
    const retryAfterSeconds = Math.ceil(
      (SEED_REFRESH_COOLDOWN_MS - (now - lastSeedRefreshAttemptAt)) / 1000,
    );
    return {
      success: false,
      state,
      refreshAttempted: false,
      refreshed: false,
      message: "seed refresh recently attempted; backing off",
      txHashCurrentSeed: null,
      retryAfterSeconds,
    };
  }

  const attempt = (async (): Promise<EnsureCurrentEpochSeedResult> => {
    lastSeedRefreshAttemptSeedId = seedId;
    lastSeedRefreshAttemptAt = Date.now();

    const refresh = await submitSeedRefresh(env);
    state = await readCurrentEpochSeedState(env).catch(() => state);

    // Channels occasionally accepts tx but omits hash; when that happens,
    // poll chain state briefly before declaring failure.
    if (state.activeSeed === null && !refresh.success) {
      const msg = (refresh.message ?? "").toLowerCase();
      const shouldRecheck = msg.includes("did not return hash") || isRetryableDirectClaimMessage(msg);
      if (shouldRecheck) {
        for (const delayMs of SEED_REFRESH_RECHECK_DELAYS_MS) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          state = await readCurrentEpochSeedState(env).catch(() => state);
          if (state.activeSeed !== null) {
            break;
          }
        }
      }
    }

    const indexed = state.activeSeed !== null;
    return {
      success: indexed,
      state,
      refreshAttempted: true,
      refreshed: refresh.success || indexed,
      message: indexed ? null : (refresh.message ?? "seed refresh failed"),
      txHashCurrentSeed: refresh.txHashCurrentSeed,
    };
  })();

  inFlightSeedEnsureSeedId = seedId;
  inFlightSeedEnsurePromise = attempt;
  try {
    return await attempt;
  } finally {
    if (inFlightSeedEnsurePromise === attempt) {
      inFlightSeedEnsurePromise = null;
      inFlightSeedEnsureSeedId = null;
    }
  }
}

export async function submitClaimDirect(
  env: WorkerEnv,
  request: RelayClaimRequest,
): Promise<RelaySubmitResult> {
  const config = resolveDirectClaimConfig(env);
  if (!config) {
    return {
      type: "fatal",
      message:
        "direct claim is not configured; set SCORE_CONTRACT_ID, RELAYER_URL, and RELAYER_API_KEY for relayer-only submission",
    };
  }

  let phase = "init";
  try {
    phase = "parse_payload";
    const seal = extractGroth16SealFromProverResponse(request.proverResponse);
    const journalRaw = hexToBytes(request.journalRawHex, "journal_raw_hex");

    phase = "build_payload_bindings";
    const payload = await buildSubmitScorePayloadViaBindings(
      config.scoreContractId,
      seal,
      journalRaw,
    );

    console.log("[claim-direct] relayer-only submit", {
      jobId: request.jobId,
      relayerUrl: config.channels.baseUrl,
      journalDigestHex: request.journalDigestHex,
      journalBytes: journalRaw.length,
      sealBytes: seal.length,
      authEntries: payload.auth.length,
    });

    phase = "send_tx_channels_soroban";
    return submitSorobanOperationViaChannels(config.channels, payload);
  } catch (error) {
    const detail = safeErrorMessage(error);
    console.error("[claim-direct] submit failed", {
      jobId: request.jobId,
      phase,
      message: detail,
    });

    const retryable = isRetryableDirectClaimMessage(detail);
    return {
      type: retryable ? "retry" : "fatal",
      message: `direct claim failed during ${phase}: ${detail}`,
      errorDetail: buildErrorDetail({
        phase,
        message: detail,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    };
  }
}
