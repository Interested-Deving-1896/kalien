// Swap service for KALIEN -> KALE via Soroswap Router
// Calls the router contract directly — no soroswap SDK or API key needed.
// Auth entries are signed client-side with the smart-account-kit passkey.
//
// All swap addresses are configured via VITE_ env vars.

import {
  TransactionBuilder,
  xdr,
  Contract,
  Address,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { loadSmartWalletModule } from "../wallet/loader";

// ── Types ────────────────────────────────────────────────────────────────

export interface SwapConfig {
  soroswapRouter: string;
  kaleSac: string;
  kalienSac: string;
}

function getEnv(key: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve swap config from env vars.
 * Returns `null` when required vars are missing (swap UI hidden).
 */
export function getSwapConfig(
  kalienSac: string | null,
): SwapConfig | null {
  if (!kalienSac) return null;

  const soroswapRouter = getEnv("VITE_SOROSWAP_ROUTER");
  const kaleSac = getEnv("VITE_KALE_SAC");
  if (!soroswapRouter || !kaleSac) return null;

  return { soroswapRouter, kaleSac, kalienSac };
}

// ── Types ────────────────────────────────────────────────────────────────

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
}

// ── Quote ────────────────────────────────────────────────────────────────

/**
 * Get estimated KALE output for a given KALIEN input amount.
 * Uses the router's `router_get_amounts_out` view function — no auth or balance needed.
 */
export async function getSwapQuote(
  swapCfg: SwapConfig,
  amountIn: bigint,
  slippageBps = 300,
): Promise<SwapQuote> {
  const walletModule = await loadSmartWalletModule();
  const config = walletModule.getSmartAccountConfig();
  const kit = walletModule.getSmartAccountKit();

  const server = new rpc.Server(config.rpcUrl);
  const router = new Contract(swapCfg.soroswapRouter);
  const deployerAccount = await server.getAccount(kit.deployerPublicKey);

  const path = [swapCfg.kalienSac, swapCfg.kaleSac];
  const pathScVal = xdr.ScVal.scvVec(path.map((a) => new Address(a).toScVal()));

  const tx = new TransactionBuilder(deployerAccount, {
    fee: "1000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      router.call(
        "router_get_amounts_out",
        nativeToScVal(amountIn, { type: "i128" }),
        pathScVal,
      ),
    )
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error ?? "quote simulation failed");
  }

  const returnValue = simResult.result?.retval;
  if (!returnValue) {
    throw new Error("no return value from quote simulation");
  }

  const amounts: bigint[] = scValToNative(returnValue);
  const amountOut = amounts[amounts.length - 1];
  const minAmountOut = amountOut - (amountOut * BigInt(slippageBps)) / 10000n;

  return { amountIn, amountOut, minAmountOut };
}

// ── Execute ──────────────────────────────────────────────────────────────

/**
 * Execute KALIEN -> KALE swap via Soroswap Router.
 *
 * Flow: build tx → simulate → sign auth entries (passkey) → rebuild XDR → submit via relay.
 */
export async function executeSwap(
  swapCfg: SwapConfig,
  amountIn: bigint,
  minAmountOut: bigint,
  toAddress: string,
  credentialId: string,
): Promise<{ hash: string }> {
  const walletModule = await loadSmartWalletModule();
  const config = walletModule.getSmartAccountConfig();
  const kit = walletModule.getSmartAccountKit();

  const server = new rpc.Server(config.rpcUrl);
  const router = new Contract(swapCfg.soroswapRouter);
  const deployerAccount = await server.getAccount(kit.deployerPublicKey);

  const path = [swapCfg.kalienSac, swapCfg.kaleSac];
  const pathScVal = xdr.ScVal.scvVec(path.map((a) => new Address(a).toScVal()));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // Build swap transaction (deployer is source / fee payer; smart wallet authorises via auth entries)
  const tx = new TransactionBuilder(deployerAccount, {
    fee: "10000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      router.call(
        "swap_exact_tokens_for_tokens",
        nativeToScVal(amountIn, { type: "i128" }),
        nativeToScVal(minAmountOut, { type: "i128" }),
        pathScVal,
        new Address(toAddress).toScVal(),
        nativeToScVal(deadline, { type: "u64" }),
      ),
    )
    .setTimeout(300)
    .build();

  // Simulate to get resource costs and auth entries
  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error ?? "swap simulation failed");
  }

  // Assemble with simulation results
  const assembled = rpc.assembleTransaction(tx, simResult).build();

  // Extract and sign auth entries with passkey
  const envelope = xdr.TransactionEnvelope.fromXDR(assembled.toXDR(), "base64");
  const v1 = envelope.v1();
  const txBody = v1.tx();
  const firstOp = txBody.operations()[0];
  const invokeOp = firstOp.body().invokeHostFunctionOp();
  const unsignedAuth = invokeOp.auth();

  const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of unsignedAuth) {
    const signed = await kit.signAuthEntry(entry, { credentialId });
    signedAuth.push(signed);
  }

  // Rebuild transaction with signed auth entries
  const newInvokeOp = new xdr.InvokeHostFunctionOp({
    hostFunction: invokeOp.hostFunction(),
    auth: signedAuth,
  });

  const newOp = new xdr.Operation({
    sourceAccount: firstOp.sourceAccount(),
    body: xdr.OperationBody.invokeHostFunction(newInvokeOp),
  });

  const newTxBody = new xdr.Transaction({
    sourceAccount: txBody.sourceAccount(),
    fee: txBody.fee(),
    seqNum: txBody.seqNum(),
    cond: txBody.cond(),
    memo: txBody.memo(),
    operations: [newOp],
    ext: txBody.ext(),
  });

  const signedEnvelope = xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({
      tx: newTxBody,
      signatures: v1.signatures(),
    }),
  );

  const signedXdr = signedEnvelope.toXDR("base64");

  // Submit via relay proxy (Channels relayer fee-bumps and submits)
  const response = await fetch("/api/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xdr: signedXdr }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`relay submission failed: ${text}`);
  }

  const result: { success: boolean; error?: string; data?: { hash?: string } } =
    await response.json();
  if (!result.success) {
    throw new Error(result.error ?? "swap submission failed");
  }

  return { hash: result.data?.hash ?? "" };
}
