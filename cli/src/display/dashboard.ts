import * as ansi from "./ansi";

export interface DashboardStats {
  totalGamesPlayed: number;
  epochGamesPlayed: number;
  bestScore: number;
  lastSubmittedScore: number;
  totalSubmissions: number;
  lastSubmitStatus: string;
  epochRemainingSec: number;
  epoch: number;
  threads: number;
  address: string;
  startTime: number;
  variantsTested: number;
  onChainBestScore: number;
  epochSubmissions: number;
  maxSubmissionsPerEpoch: number;
  settleRemainingSec: number;
}

const LOGO = [
  "  _  __   _   _     ___ ___ _  _ ",
  " | |/ /  /_\\ | |   |_ _| __| \\| |",
  " | ' <  / _ \\| |__  | || _|| .` |",
  " |_|\\_\\/_/ \\_\\____||___|___|_|\\_|",
];

let lastLineCount = 0;

export function renderDashboard(stats: DashboardStats): void {
  const {
    totalGamesPlayed,
    epochGamesPlayed,
    bestScore,
    lastSubmittedScore,
    totalSubmissions,
    lastSubmitStatus,
    epochRemainingSec,
    epoch,
    threads,
    address,
    startTime,
    variantsTested,
    onChainBestScore,
    epochSubmissions,
    maxSubmissionsPerEpoch,
    settleRemainingSec,
  } = stats;

  const elapsedSec = (Date.now() - startTime) / 1000;
  const gamesPerMin = elapsedSec > 0 ? ((totalGamesPlayed / elapsedSec) * 60).toFixed(1) : "0.0";
  const elapsedStr = formatDuration(elapsedSec);
  const epochStr = formatDuration(epochRemainingSec);
  const shortAddr = address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;

  const submitted = lastSubmittedScore > 0;
  const scoreColor = submitted ? ansi.green : ansi.brightGreen;
  const scoreLabel = submitted ? `${bestScore} (submitted: ${lastSubmittedScore})` : String(bestScore);

  const budgetColor = epochSubmissions >= maxSubmissionsPerEpoch ? ansi.red
    : epochSubmissions >= maxSubmissionsPerEpoch - 2 ? ansi.yellow
    : ansi.green;
  const budgetLabel = `${maxSubmissionsPerEpoch - epochSubmissions}/${maxSubmissionsPerEpoch}`;

  const lines: string[] = [];

  // Logo
  for (const line of LOGO) {
    lines.push(ansi.color(ansi.brightCyan, line));
  }
  lines.push("");

  // Status
  lines.push(`  ${ansi.color(ansi.gray, "Address:")}    ${ansi.color(ansi.white, shortAddr)}    ${ansi.color(ansi.gray, "Threads:")} ${ansi.color(ansi.white, String(threads))}    ${ansi.color(ansi.gray, "Uptime:")} ${ansi.color(ansi.white, elapsedStr)}`);
  lines.push("");

  // Epoch info
  lines.push(`  ${ansi.color(ansi.gray, "Seed:")}       ${ansi.color(ansi.brightWhite, String(epoch))}    ${ansi.color(ansi.gray, "Next seed:")} ${ansi.color(ansi.cyan, epochStr)}`);
  lines.push(`  ${ansi.color(ansi.gray, "Games:")}      ${ansi.color(ansi.brightWhite, String(epochGamesPlayed))} ${ansi.color(ansi.dim, `this epoch (${totalGamesPlayed} total)`)}    ${ansi.color(ansi.gray, "Rate:")} ${ansi.color(ansi.white, gamesPerMin + "/min")}`);
  lines.push(`  ${ansi.color(ansi.gray, "Variants:")}   ${ansi.color(ansi.magenta, String(variantsTested))} ${ansi.color(ansi.dim, "configs tested this epoch")}`);
  lines.push("");

  // Score section
  lines.push(`  ${ansi.color(ansi.gray, "Best:")}       ${ansi.color(scoreColor, scoreLabel)}`);

  if (onChainBestScore > 0) {
    lines.push(`  ${ansi.color(ansi.gray, "On-chain:")}   ${ansi.color(ansi.brightYellow, String(onChainBestScore))} ${ansi.color(ansi.dim, "(all-time high)")}`);
  }

  // Settle indicator
  if (settleRemainingSec > 0) {
    lines.push(`  ${ansi.color(ansi.gray, "Settling:")}   ${ansi.color(ansi.cyan, `${settleRemainingSec}s`)} ${ansi.color(ansi.dim, "waiting for score to stabilize")}`);
  }
  lines.push("");

  // Submission info
  lines.push(`  ${ansi.color(ansi.gray, "Submissions:")} ${ansi.color(ansi.brightYellow, String(totalSubmissions))}    ${ansi.color(ansi.gray, "Budget:")} ${ansi.color(budgetColor, budgetLabel)} ${ansi.color(ansi.dim, "remaining this epoch")}`);
  if (lastSubmitStatus) {
    lines.push(`  ${ansi.color(ansi.gray, "Status:")}     ${lastSubmitStatus}`);
  }
  lines.push("");
  lines.push(`  ${ansi.color(ansi.dim, "Press Ctrl+C to stop (will submit best tape before exit)")}`);

  // Clear previous output, write new
  const output = (lastLineCount > 0 ? ansi.cursorUp(lastLineCount) : "") +
    lines.map((l) => ansi.clearLine + l).join("\n") +
    ansi.clearDown;

  process.stdout.write(output + "\n");
  lastLineCount = lines.length;
}

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
