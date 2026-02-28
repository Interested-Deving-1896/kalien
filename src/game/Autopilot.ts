import {
  SHIP_BULLET_RANGE,
  SHIP_BULLET_SPEED,
  SHIP_MAX_SPEED,
  SHIP_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./constants";
import { shortestDelta } from "./torus";
import type { Asteroid, Bullet, Saucer, Ship, Vec2 } from "./types";

/**
 * AI Autopilot Engine for Stellar ZK Asteroids
 *
 * This class provides intelligent ship control by analyzing the game state
 * and generating appropriate inputs. It's designed to be modular and easy
 * to modify - all tunable parameters are at the top of the class.
 *
 * The AI uses a threat-based priority system:
 * 1. Immediate collision threats (dodge)
 * 2. Incoming bullets (evade)
 * 3. Nearest targetable enemy (engage)
 */

// ============================================================================
// TUNABLE PARAMETERS - Modify these to change AI behavior
// ============================================================================

export interface AutopilotConfig {
  /** How far ahead to predict collisions (seconds) */
  collisionLookahead: number;
  /** Distance at which threats become critical and require evasion */
  dangerRadius: number;
  /** Distance at which we start being cautious */
  cautionRadius: number;
  /** How accurately the ship must aim before firing (radians) */
  aimTolerance: number;
  /** Minimum distance to maintain from threats when not attacking */
  safeDistance: number;
  /** How much to lead targets (multiplier for prediction) */
  leadFactor: number;
  /** Prefer shooting small asteroids first (they're worth more points) */
  preferSmallAsteroids: boolean;
  /** Maximum angle difference to consider a shot viable */
  maxShotAngle: number;
  /** How aggressively to pursue targets vs play defensively (0-1) */
  aggression: number;
  /** Cooldown between shots to avoid wasting bullets */
  shotPatience: number;
  /** Danger radius multiplier when on last life */
  lowLivesDangerMult: number;
  /** Aggression bonus per wave (additive, capped at 1.0) */
  waveAggressionBonus: number;
  /** Frame count after which lurk-kill incentive kicks in */
  lurkKillFrames: number;
}

// ============================================================================
// AUTOPILOT CLASS
// ============================================================================

export interface AutopilotInput {
  left: boolean;
  right: boolean;
  thrust: boolean;
  fire: boolean;
}

export interface GameStateSnapshot {
  ship: Ship;
  asteroids: Asteroid[];
  saucers: Saucer[];
  bullets: Bullet[]; // Player bullets
  saucerBullets: Bullet[];
  wave: number;
  lives: number;
  timeSinceLastKill: number;
}

interface Threat {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  type: "asteroid" | "saucer" | "bullet";
  danger: number; // 0-1 danger level
  timeToImpact: number;
  entity: Asteroid | Saucer | Bullet;
}

interface Target {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  priority: number;
  angle: number; // Angle to aim at
  distance: number;
  entity: Asteroid | Saucer;
}

export class Autopilot {
  readonly config: AutopilotConfig;

  private enabled = false;
  private lastShotTime = 0;

  // Debug/visualization data
  private debugThreats: Threat[] = [];
  private debugTarget: Target | null = null;

  // Per-frame effective parameters (adjusted by wave/lives/lurk)
  private effectiveDangerRadius: number;
  private effectiveCautionRadius: number;
  private effectiveAggression: number;
  private lurkPressure = false;

  static defaults(): AutopilotConfig {
    return {
      collisionLookahead: 1.5,
      dangerRadius: 120,
      cautionRadius: 200,
      aimTolerance: 0.12,
      safeDistance: 180,
      leadFactor: 1.0,
      preferSmallAsteroids: false,
      maxShotAngle: Math.PI / 6,
      aggression: 0.7,
      shotPatience: 0.05,
      lowLivesDangerMult: 1.4,
      waveAggressionBonus: 0.03,
      lurkKillFrames: 240,
    };
  }

  constructor(config?: Partial<AutopilotConfig>) {
    this.config = { ...Autopilot.defaults(), ...config };
    this.effectiveDangerRadius = this.config.dangerRadius;
    this.effectiveCautionRadius = this.config.cautionRadius;
    this.effectiveAggression = this.config.aggression;
  }

  /** Enable or disable the autopilot */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.debugTarget = null;
      this.debugThreats = [];
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle autopilot on/off */
  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /** Get debug visualization data */
  getDebugData(): { threats: Threat[]; target: Target | null } {
    return {
      threats: this.debugThreats,
      target: this.debugTarget,
    };
  }

  /**
   * Main update function - analyzes game state and returns input commands
   */
  update(state: GameStateSnapshot, _dt: number, gameTime: number): AutopilotInput {
    const input: AutopilotInput = {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    };

    if (!this.enabled || !state.ship.canControl || !state.ship.alive) {
      return input;
    }

    const ship = state.ship;

    // Adjust effective parameters based on wave / lives / lurk state
    const c = this.config;
    const dangerMult = state.lives <= 1 ? c.lowLivesDangerMult : 1.0;
    this.effectiveDangerRadius = c.dangerRadius * dangerMult;
    this.effectiveCautionRadius = c.cautionRadius * dangerMult;
    this.effectiveAggression = Math.min(1.0, c.aggression + state.wave * c.waveAggressionBonus);
    this.lurkPressure = state.timeSinceLastKill >= c.lurkKillFrames;

    // 1. Analyze all threats
    const threats = this.analyzeThreats(ship, state);
    this.debugThreats = threats;

    // 2. Check for immediate danger requiring evasion
    const criticalThreats = threats.filter((t) => t.danger > 0.7);
    const shouldEvade = criticalThreats.length > 0;

    if (shouldEvade) {
      return this.generateEvasionInput(ship, criticalThreats);
    }

    // 3. Find best target to engage
    const target = this.selectTarget(ship, state);
    this.debugTarget = target;

    if (!target) {
      // No targets - just drift safely
      return this.generateIdleInput(ship, threats);
    }

    // 4. Generate attack input
    return this.generateAttackInput(ship, target, threats, gameTime);
  }

  // ============================================================================
  // THREAT ANALYSIS
  // ============================================================================

  private analyzeThreats(ship: Ship, state: GameStateSnapshot): Threat[] {
    const threats: Threat[] = [];

    // Analyze asteroids
    for (const asteroid of state.asteroids) {
      if (!asteroid.alive) continue;

      const threat = this.assessThreat(ship, asteroid, "asteroid");
      if (threat) threats.push(threat);
    }

    // Analyze saucers
    for (const saucer of state.saucers) {
      if (!saucer.alive) continue;

      const threat = this.assessThreat(ship, saucer, "saucer");
      if (threat) {
        // Saucers are more dangerous
        threat.danger = Math.min(1, threat.danger * 1.3);
        threats.push(threat);
      }
    }

    // Analyze saucer bullets (most dangerous!)
    for (const bullet of state.saucerBullets) {
      if (!bullet.alive) continue;

      const threat = this.assessThreat(ship, bullet, "bullet");
      if (threat) {
        // Bullets are very dangerous
        threat.danger = Math.min(1, threat.danger * 1.5);
        threats.push(threat);
      }
    }

    // Sort by danger level
    threats.sort((a, b) => b.danger - a.danger);

    return threats;
  }

  private assessThreat(
    ship: Ship,
    entity: Asteroid | Saucer | Bullet,
    type: "asteroid" | "saucer" | "bullet",
  ): Threat | null {
    const dangerR = this.effectiveDangerRadius;
    const cautionR = this.effectiveCautionRadius;

    const delta = shortestDelta(ship.x, ship.y, entity.x, entity.y);
    const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y);

    // Skip if too far
    if (distance > cautionR * 2) return null;

    // Calculate relative velocity
    const relVx = entity.vx - ship.vx;
    const relVy = entity.vy - ship.vy;

    // Time to closest approach
    const timeToImpact = this.timeToClosestApproach(0, 0, relVx, relVy, delta.x, delta.y);

    // Only care about future threats
    if (timeToImpact < 0 || timeToImpact > this.config.collisionLookahead) {
      // Still track nearby entities as low-level threats
      if (distance < cautionR) {
        return {
          x: entity.x,
          y: entity.y,
          vx: entity.vx,
          vy: entity.vy,
          radius: entity.radius,
          type,
          danger: 0.2 * (1 - distance / cautionR),
          timeToImpact: 999,
          entity,
        };
      }
      return null;
    }

    // Calculate closest approach distance
    const futureX = delta.x + relVx * timeToImpact;
    const futureY = delta.y + relVy * timeToImpact;
    const closestDistance = Math.sqrt(futureX * futureX + futureY * futureY);

    const collisionRadius = SHIP_RADIUS + entity.radius + 20; // Buffer

    // Calculate danger level
    let danger = 0;

    if (closestDistance < collisionRadius) {
      // Will collide!
      danger = 1.0;
    } else if (closestDistance < dangerR) {
      danger = 0.8 * (1 - closestDistance / dangerR);
    } else if (closestDistance < cautionR) {
      danger = 0.3 * (1 - closestDistance / cautionR);
    }

    // Increase danger for faster-approaching threats
    const approachSpeed = Math.sqrt(relVx * relVx + relVy * relVy);
    danger *= 1 + approachSpeed / 200;

    // Time pressure increases danger
    if (timeToImpact < 0.5) {
      danger *= 1.5;
    }

    danger = Math.min(1, danger);

    if (danger < 0.1) return null;

    return {
      x: entity.x,
      y: entity.y,
      vx: entity.vx,
      vy: entity.vy,
      radius: entity.radius,
      type,
      danger,
      timeToImpact,
      entity,
    };
  }

  // ============================================================================
  // TARGET SELECTION
  // ============================================================================

  private selectTarget(ship: Ship, state: GameStateSnapshot): Target | null {
    const targets: Target[] = [];

    // Score asteroids as targets
    for (const asteroid of state.asteroids) {
      if (!asteroid.alive) continue;

      const target = this.scoreTarget(ship, asteroid);
      if (target) targets.push(target);
    }

    // Score saucers as targets (high priority!)
    for (const saucer of state.saucers) {
      if (!saucer.alive) continue;

      const target = this.scoreTarget(ship, saucer);
      if (target) {
        target.priority *= 2; // Saucers are priority targets
        targets.push(target);
      }
    }

    if (targets.length === 0) return null;

    // Sort by priority
    targets.sort((a, b) => b.priority - a.priority);

    return targets[0];
  }

  private scoreTarget(ship: Ship, entity: Asteroid | Saucer): Target | null {
    const delta = shortestDelta(ship.x, ship.y, entity.x, entity.y);
    const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y);

    // Calculate lead angle (where to aim to hit moving target)
    const leadPos = this.calculateLeadPosition(ship, entity);
    const leadDelta = shortestDelta(ship.x, ship.y, leadPos.x, leadPos.y);
    const aimAngle = Math.atan2(leadDelta.y, leadDelta.x);

    // Calculate angle difference
    const angleDiff = this.normalizeAngle(aimAngle - ship.angle);

    // Priority based on distance (closer = higher priority)
    let priority = 1 / (distance + 50);

    // Bonus for targets we're already aimed at
    if (Math.abs(angleDiff) < this.config.maxShotAngle) {
      priority *= 1.5;
    }

    // Asteroid size priority
    if ("size" in entity) {
      const asteroid = entity as Asteroid;
      if (this.config.preferSmallAsteroids) {
        if (asteroid.size === "small") priority *= 1.5;
        else if (asteroid.size === "medium") priority *= 1.2;
      } else {
        // Prefer large asteroids (easier to hit)
        if (asteroid.size === "large") priority *= 1.3;
      }
    }

    // Penalize targets that are too close (dangerous to engage)
    if (distance < this.config.safeDistance * 0.5) {
      priority *= 0.5;
    }

    return {
      x: entity.x,
      y: entity.y,
      vx: entity.vx,
      vy: entity.vy,
      radius: entity.radius,
      priority,
      angle: aimAngle,
      distance,
      entity,
    };
  }

  private calculateLeadPosition(
    ship: Ship,
    entity: { x: number; y: number; vx: number; vy: number },
  ): Vec2 {
    const delta = shortestDelta(ship.x, ship.y, entity.x, entity.y);
    const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y);

    // Match game bullet speed boost model:
    // shipSpeedApprox = (|vx| + |vy|) * 3/4, boost = shipSpeedApprox * 89/256.
    const shipSpeedApprox = (Math.abs(ship.vx) + Math.abs(ship.vy)) * 0.75;
    const bulletSpeed = SHIP_BULLET_SPEED + shipSpeedApprox * (89 / 256);
    const travelTime = distance / bulletSpeed;

    // Lead the target
    const leadX = entity.x + entity.vx * travelTime * this.config.leadFactor;
    const leadY = entity.y + entity.vy * travelTime * this.config.leadFactor;

    return { x: leadX, y: leadY };
  }

  // ============================================================================
  // INPUT GENERATION
  // ============================================================================

  private generateEvasionInput(ship: Ship, criticalThreats: Threat[]): AutopilotInput {
    const input: AutopilotInput = {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    };

    // Calculate escape vector (away from all threats, weighted by danger)
    let escapeX = 0;
    let escapeY = 0;

    for (const threat of criticalThreats) {
      const delta = shortestDelta(ship.x, ship.y, threat.x, threat.y);
      const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y) || 1;

      // Vector away from threat, weighted by danger
      escapeX -= (delta.x / distance) * threat.danger;
      escapeY -= (delta.y / distance) * threat.danger;
    }

    // Normalize escape vector
    const escapeMag = Math.sqrt(escapeX * escapeX + escapeY * escapeY) || 1;
    escapeX /= escapeMag;
    escapeY /= escapeMag;

    // Desired escape angle
    const escapeAngle = Math.atan2(escapeY, escapeX);
    const angleDiff = this.normalizeAngle(escapeAngle - ship.angle);

    // Turn toward escape direction
    if (Math.abs(angleDiff) > 0.1) {
      if (angleDiff > 0) {
        input.right = true;
      } else {
        input.left = true;
      }
    }

    // Thrust if roughly facing escape direction
    if (Math.abs(angleDiff) < Math.PI / 2) {
      input.thrust = true;
    }

    // Opportunistic shot if a threat is in our sights
    const mostDangerous = criticalThreats[0];
    if (mostDangerous) {
      const leadPos = this.calculateLeadPosition(ship, mostDangerous.entity);
      const leadDelta = shortestDelta(ship.x, ship.y, leadPos.x, leadPos.y);
      const aimAngle = Math.atan2(leadDelta.y, leadDelta.x);
      const aimDiff = Math.abs(this.normalizeAngle(aimAngle - ship.angle));

      if (aimDiff < this.config.aimTolerance * 2) {
        input.fire = true;
      }
    }

    return input;
  }

  private generateAttackInput(
    ship: Ship,
    target: Target,
    threats: Threat[],
    gameTime: number,
  ): AutopilotInput {
    const input: AutopilotInput = {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    };

    // Calculate angle to target
    const angleDiff = this.normalizeAngle(target.angle - ship.angle);

    // Turn toward target
    if (Math.abs(angleDiff) > this.config.aimTolerance / 2) {
      if (angleDiff > 0) {
        input.right = true;
      } else {
        input.left = true;
      }
    }

    // Fire if aimed
    // Lurk pressure: relax aim tolerance to kill faster
    const aimTol = this.lurkPressure ? this.config.aimTolerance * 1.5 : this.config.aimTolerance;

    if (Math.abs(angleDiff) < aimTol) {
      // Check bullet will reach target
      const bulletRange = SHIP_BULLET_RANGE;
      if (target.distance < bulletRange * 0.9) {
        // Rate limit shots (faster when lurk pressure)
        const patience = this.lurkPressure ? this.config.shotPatience * 0.5 : this.config.shotPatience;
        if (gameTime - this.lastShotTime > patience) {
          input.fire = true;
          this.lastShotTime = gameTime;
        }
      }
    }

    // Thrust management
    const speed = Math.hypot(ship.vx, ship.vy);
    const moderateThreats = threats.filter((t) => t.danger > 0.3);
    const aggression = this.effectiveAggression;

    if (moderateThreats.length > 0) {
      // Threats nearby - be cautious about thrusting
      // Only thrust if moving away from threats
      const threatCenter = this.averagePosition(moderateThreats);
      const toThreat = shortestDelta(ship.x, ship.y, threatCenter.x, threatCenter.y);
      const thrustDir = { x: Math.cos(ship.angle), y: Math.sin(ship.angle) };

      // Dot product: positive means thrusting toward threat
      const dot = toThreat.x * thrustDir.x + toThreat.y * thrustDir.y;

      if (dot < 0) {
        // Thrusting away from threats
        input.thrust = true;
      }
    } else {
      // No immediate threats
      // Approach target if far, maintain distance if close
      const approachDist = this.lurkPressure ? this.config.safeDistance : this.config.safeDistance * 1.5;
      if (target.distance > approachDist) {
        // Move toward target if aimed roughly at it
        if (Math.abs(angleDiff) < Math.PI / 3) {
          input.thrust = speed < SHIP_MAX_SPEED * aggression;
        }
      } else if (target.distance < this.config.safeDistance * 0.8) {
        // Too close - thrust away
        const awayAngle = this.normalizeAngle(target.angle + Math.PI - ship.angle);
        if (Math.abs(awayAngle) < Math.PI / 3) {
          input.thrust = true;
        }
      }
    }

    return input;
  }

  private generateIdleInput(ship: Ship, threats: Threat[]): AutopilotInput {
    const input: AutopilotInput = {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    };

    // If there are any threats, rotate toward center for safety
    if (threats.length > 0) {
      const center = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
      const delta = shortestDelta(ship.x, ship.y, center.x, center.y);
      const centerAngle = Math.atan2(delta.y, delta.x);
      const angleDiff = this.normalizeAngle(centerAngle - ship.angle);

      if (Math.abs(angleDiff) > 0.2) {
        if (angleDiff > 0) input.right = true;
        else input.left = true;
      }
    }

    return input;
  }

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /** Normalize angle to [-PI, PI] */
  private normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  }

  /** Calculate time to closest approach between two objects */
  private timeToClosestApproach(
    _x1: number,
    _y1: number,
    vx: number,
    vy: number,
    dx: number,
    dy: number,
  ): number {
    const vMagSq = vx * vx + vy * vy;
    if (vMagSq < 0.001) return 999; // Essentially stationary

    // Time at which distance is minimized
    // d(t) = |p0 + v*t|
    // d'(t) = 0 when t = -(p0 · v) / |v|²
    const t = -(dx * vx + dy * vy) / vMagSq;
    return t;
  }

  /** Average position of threats */
  private averagePosition(threats: Threat[]): Vec2 {
    if (threats.length === 0) return { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };

    let x = 0;
    let y = 0;
    for (const t of threats) {
      x += t.x;
      y += t.y;
    }
    return { x: x / threats.length, y: y / threats.length };
  }
}
