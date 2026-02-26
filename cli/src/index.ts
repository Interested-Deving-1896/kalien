#!/usr/bin/env bun

import * as ansi from "./display/ansi";

const HELP = `
${ansi.brightCyan}KALIEN${ansi.reset} - Autonomous Asteroids Farming CLI

${ansi.bold}USAGE${ansi.reset}
  kalien run --address <STELLAR_ADDRESS> [options]
  kalien replay <tape-file>

${ansi.bold}COMMANDS${ansi.reset}
  run       Start autonomous farming (play games + submit tapes)
  replay    ASCII replay of a .tape file in the terminal

${ansi.bold}RUN OPTIONS${ansi.reset}
  --address <addr>    Stellar wallet address for claims (required)
  --threads <n>       Parallel worker count (default: CPU cores / 2)
  --max               Use all CPU cores
  --interval <min>    Min minutes between submissions within an epoch (default: 1)
  --api-url <url>     API base URL (default: https://kalien.xyz)

${ansi.bold}EXAMPLES${ansi.reset}
  kalien run --address GABC...XYZ
  kalien run --address GABC...XYZ --threads 4 --interval 5
  kalien run --address GABC...XYZ --max
  kalien replay game.tape
`;

function parseArgs(argv: string[]): { command: string; args: Record<string, string>; positional: string[] } {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!command && !arg.startsWith("-")) {
      command = arg;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "help" || key === "max") {
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
        console.error("Error: Invalid Stellar address format (must be 56 chars, starting with G or C)");
        process.exit(1);
      }

      const { runCommand } = await import("./commands/run");
      await runCommand({
        address,
        threads: args["threads"] ? parseInt(args["threads"], 10) : 0,
        max: args["max"] === "true",
        interval: args["interval"] ? parseFloat(args["interval"]) : 1,
        apiUrl: args["api-url"] || "https://kalien.xyz",
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
