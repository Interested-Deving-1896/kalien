// Swap service for KALIEN -> KALE via Soroswap Router
// Calls the router contract directly — no soroswap SDK or API key needed.
// Auth entries are signed client-side with the smart-account-kit passkey.
//
// Network-aware: addresses are resolved from VITE_NETWORK_PASSPHRASE.
// On testnet the KALE SAC must be set via VITE_KALE_SAC env var.

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
import { PUBLIC_NETWORK_PASSPHRASE } from "../consts";

// ── Per-network addresses ────────────────────────────────────────────────

interface SwapNetworkConfig {
  soroswapRouter: string;
  soroswapFactory: string;
  kaleSac: string;
}

const MAINNET_CONFIG: SwapNetworkConfig = {
  soroswapRouter: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
  soroswapFactory: "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2",
  kaleSac: "CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV",
};

const TESTNET_CONFIG: Partial<SwapNetworkConfig> = {
  soroswapRouter: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  soroswapFactory: "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY",
  // KALE SAC on testnet must be set via VITE_KALE_SAC — no universal default.
  kaleSac: undefined,
};

function getEnvKaleSac(): string | undefined {
  const value = import.meta.env.VITE_KALE_SAC;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve swap addresses for the active network.
 * Returns `null` when the configuration is incomplete (e.g. testnet without VITE_KALE_SAC).
 */
export function getSwapConfig(
  networkPassphrase: string,
  kalienSac: string | null,
): SwapNetworkConfig & { kalienSac: string } | null {
  if (!kalienSac) return null;

  const isMainnet = networkPassphrase === PUBLIC_NETWORK_PASSPHRASE;
  const base = isMainnet ? MAINNET_CONFIG : TESTNET_CONFIG;

  // Env override only applies to testnet; mainnet addresses are hardcoded.
  const kaleSac = isMainnet ? base.kaleSac : (getEnvKaleSac() ?? base.kaleSac);
  if (!base.soroswapRouter || !base.soroswapFactory || !kaleSac) {
    return null;
  }

  return {
    soroswapRouter: base.soroswapRouter,
    soroswapFactory: base.soroswapFactory,
    kaleSac,
    kalienSac,
  };
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
  swapCfg: SwapNetworkConfig & { kalienSac: string },
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
  swapCfg: SwapNetworkConfig & { kalienSac: string },
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
