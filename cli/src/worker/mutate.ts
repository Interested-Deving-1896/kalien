import type { AutopilotConfig } from "../../../src/game/Autopilot";

interface ParamBounds {
  min: number;
  max: number;
}

const BOUNDS: Record<string, ParamBounds> = {
  collisionLookahead: { min: 0.5, max: 3.0 },
  dangerRadius: { min: 60, max: 250 },
  cautionRadius: { min: 150, max: 400 },
  aimTolerance: { min: 0.05, max: 0.25 },
  safeDistance: { min: 80, max: 300 },
  leadFactor: { min: 0.5, max: 1.5 },
  maxShotAngle: { min: 0.26, max: 1.05 },
  aggression: { min: 0.3, max: 1.0 },
  shotPatience: { min: 0.02, max: 0.15 },
  lowLivesDangerMult: { min: 1.0, max: 2.0 },
  waveAggressionBonus: { min: 0.01, max: 0.1 },
  lurkKillFrames: { min: 120, max: 600 },
};

const NUMERIC_KEYS = Object.keys(BOUNDS);

export function mutateConfig(base: AutopilotConfig): AutopilotConfig {
  const result = { ...base };

  // Pick 1-3 parameters to tweak
  const tweakCount = 1 + Math.floor(Math.random() * 3);
  const shuffled = [...NUMERIC_KEYS].sort(() => Math.random() - 0.5);
  const toTweak = shuffled.slice(0, tweakCount);

  for (const key of toTweak) {
    const bounds = BOUNDS[key];
    const range = bounds.max - bounds.min;
    const current = (result as any)[key] as number;

    // Perturbation: ±10-30% of the parameter's valid range
    const perturbScale = 0.1 + Math.random() * 0.2;
    const delta = (Math.random() * 2 - 1) * perturbScale * range;
    let newVal = current + delta;

    // Clamp to bounds
    newVal = Math.max(bounds.min, Math.min(bounds.max, newVal));
    (result as any)[key] = newVal;
  }

  // Randomly flip preferSmallAsteroids (~10% chance)
  if (Math.random() < 0.1) {
    result.preferSmallAsteroids = !result.preferSmallAsteroids;
  }

  // Enforce constraint: cautionRadius > dangerRadius + 30
  if (result.cautionRadius <= result.dangerRadius + 30) {
    result.cautionRadius = result.dangerRadius + 30;
  }

  return result;
}
