#!/usr/bin/env bun

import * as ansi from "./display/ansi";
import { NETWORKS, DEFAULT_API_URL, type NetworkName } from "./constants";

const HELP = `
${ansi.brightCyan}KALIEN${ansi.reset} - Autonomous Asteroids Farming CLI

${ansi.bold}USAGE${ansi.reset}
  kalien run --address <STELLAR_ADDRESS> [options]
  kalien replay <tape-file>
  kalien ps
  kalien cleanup [options]

${ansi.bold}COMMANDS${ansi.reset}
  run       Start autonomous farming (play games + submit tapes)
  replay    ASCII replay of a .tape file in the terminal
  ps        List active kalien run processes
  cleanup   Terminate stale kalien run processes

${ansi.bold}RUN OPTIONS${ansi.reset}
  --address <addr>      Stellar wallet address for claims (required)
  --threads <n>         Parallel worker count (default: CPU cores / 2)
  --max                 Use all CPU cores
  --interval <min>      Min minutes between submissions within an epoch (default: 1)
  --api-url <url>       API base URL (default: https://kalien.xyz)
  --network <net>          Stellar network: testnet or mainnet (default: testnet)
  --rpc-url <url>          Stellar RPC URL override (default: per network)
  --contract-id <addr>     Score contract address (default: testnet address; required for mainnet)
  --relayer-api-key <key>  OZ channels relayer API key — materializes/indexes epoch seed if cron hasn't fired yet

${ansi.bold}CLEANUP OPTIONS${ansi.reset}
  --dry-run             Show matching processes without terminating them
  --orphan-only         Only target orphaned runs (default unless --all)
  --all                 Target all matching kalien run processes
  --older-than <dur>    Minimum process age, e.g. 30s, 10m, 2h, 1d

${ansi.bold}EXAMPLES${ansi.reset}
  kalien run --address GABC...XYZ
  kalien run --address GABC...XYZ --threads 4 --interval 5
  kalien run --address GABC...XYZ --max
  kalien replay game.tape
  kalien ps
  kalien cleanup --dry-run
  kalien cleanup --orphan-only --older-than 5m
`;

function parseArgs(argv: string[]): {
  command: string;
  args: Record<string, string>;
  positional: string[];
} {
  const booleanFlags = new Set([
    "help",
    "max",
    "dry-run",
    "all",
    "orphan-only",
  ]);
  const args: Record<string, string> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!command && !arg.startsWith("-")) {
      command = arg;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        args[key] = "true";
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[++i];
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { command, args, positional };
}

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv.slice(2));

  if (args["help"] || (!command && positional.length === 0)) {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case "run": {
      const address = args["address"];
      if (!address) {
        console.error("Error: --address is required for the run command");
        console.error("Usage: kalien run --address <STELLAR_ADDRESS>");
        process.exit(1);
      }

      if (!/^[GC][A-Z2-7]{55}$/.test(address)) {
        console.error(
          "Error: Invalid Stellar address format (must be 56 chars, starting with G or C)",
        );
        process.exit(1);
      }

      const network = (args["network"] || "testnet") as NetworkName;
      if (!(network in NETWORKS)) {
        console.error(`Error: --network must be "testnet" or "mainnet"`);
        process.exit(1);
      }

      const { relayerUrl: relayerBaseUrl } = NETWORKS[network];
      const rpcUrl = args["rpc-url"] || NETWORKS[network].rpcUrl;
      const contractId = args["contract-id"] || NETWORKS[network].contractId;
      const relayerApiKey = args["relayer-api-key"] || null;

      if (!contractId) {
        console.error(
          "Error: --contract-id is required for mainnet (no default set yet)",
        );
        process.exit(1);
      }

      const { runCommand } = await import("./commands/run");
      await runCommand({
        address,
        threads: args["threads"] ? parseInt(args["threads"], 10) : 0,
        max: args["max"] === "true",
        interval: args["interval"] ? parseFloat(args["interval"]) : 1,
        apiUrl: args["api-url"] || DEFAULT_API_URL,
        rpcUrl,
        contractId,
        relayerBaseUrl,
        relayerApiKey,
      });
      break;
    }

    case "replay": {
      const tapePath = positional[0];
      if (!tapePath) {
        console.error("Error: tape file path is required");
        console.error("Usage: kalien replay <tape-file>");
        process.exit(1);
      }

      const { replayCommand } = await import("./commands/replay");
      await replayCommand(tapePath);
      break;
    }

    case "ps": {
      const { psCommand } = await import("./commands/processes");
      await psCommand();
      break;
    }

    case "cleanup": {
      const { cleanupCommand } = await import("./commands/processes");
      await cleanupCommand({
        all: args["all"] === "true",
        dryRun: args["dry-run"] === "true",
        orphanOnly:
          args["all"] === "true" ? false : args["orphan-only"] !== "false",
        olderThan: args["older-than"] || null,
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
