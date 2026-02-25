import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { resolve } from "path";

const lines = readFileSync(resolve(import.meta.dirname, ".env"), "utf-8").split("\n");
const vars: Record<string, string> = {};
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq > 0) vars[t.slice(0, eq)] = t.slice(eq + 1);
}

const account = privateKeyToAccount(vars.BOUNDLESS_PRIVATE_KEY as `0x${string}`);
console.log("Wallet:", account.address);

// Check Base Mainnet balance
const baseResp = await fetch("https://mainnet.base.org", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [account.address, "latest"], id: 1 }),
});
const baseData = (await baseResp.json()) as any;
const baseBal = BigInt(baseData.result);
console.log("Base Mainnet:", (Number(baseBal) / 1e18).toFixed(6), "ETH");

// Check Eth Sepolia balance too
const sepResp = await fetch("https://ethereum-sepolia-rpc.publicnode.com", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [account.address, "latest"], id: 1 }),
});
const sepData = (await sepResp.json()) as any;
const sepBal = BigInt(sepData.result);
console.log("Eth Sepolia:", (Number(sepBal) / 1e18).toFixed(6), "ETH");
