export function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function abbreviateHex(value: string, keep = 8): string {
  if (value.length <= keep * 2) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export function abbreviateAddress(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0 ms";
  }

  if (ms < 1000) {
    return `${ms} ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const leftoverSeconds = Math.round(seconds % 60);
  return `${minutes}m ${leftoverSeconds}s`;
}

export function formatWholeNumber(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString();
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function formatMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

export function formatCycles(cycles: number): string {
  if (cycles >= 1_000_000_000) return `${(cycles / 1_000_000_000).toFixed(1)}B`;
  if (cycles >= 1_000_000) return `${(cycles / 1_000_000).toFixed(1)}M`;
  return cycles.toLocaleString();
}

export function formatFramesAsTime(frameCount: number, fps = 60): string {
  const totalSeconds = Math.round(frameCount / fps);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export const KALIEN_SCALE = 10_000_000n;
export function toDisplayKalien(rawBalance: bigint): bigint {
  return rawBalance / KALIEN_SCALE;
}
