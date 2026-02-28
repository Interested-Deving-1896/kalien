import { privateKeyToAccount } from "viem/accounts";
import { env } from "./load-env";

const account = privateKeyToAccount(env.BOUNDLESS_PRIVATE_KEY as `0x${string}`);
console.log("Wallet:", account.address);

// Check Base Mainnet balance
const baseResp = await fetch("https://mainnet.base.org", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_getBalance",
    params: [account.address, "latest"],
    id: 1,
  }),
});
const baseData = (await baseResp.json()) as { result: string };
const baseBal = BigInt(baseData.result);
console.log("Base Mainnet:", (Number(baseBal) / 1e18).toFixed(6), "ETH");

// Check Eth Sepolia balance too
const sepResp = await fetch("https://ethereum-sepolia-rpc.publicnode.com", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_getBalance",
    params: [account.address, "latest"],
    id: 1,
  }),
});
const sepData = (await sepResp.json()) as { result: string };
const sepBal = BigInt(sepData.result);
console.log("Eth Sepolia:", (Number(sepBal) / 1e18).toFixed(6), "ETH");
