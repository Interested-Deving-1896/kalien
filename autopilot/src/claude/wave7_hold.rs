//! claude-wave7-hold: rush to wave 7, preserve one anchor asteroid, then farm saucers.

use crate::bots::{create_bot, AutopilotBot};
use crate::claude::common::*;
use crate::claude::predator::PredatorBot;
use asteroids_verifier_core::constants::{
    LURK_TIME_THRESHOLD_FRAMES, SHIP_BULLET_LIFETIME_FRAMES, SHIP_BULLET_LIMIT,
    SHIP_BULLET_SPEED_Q8_8, WORLD_HEIGHT_Q12_4, WORLD_WIDTH_Q12_4,
};
use asteroids_verifier_core::fixed_point::{
    displace_q12_4, shortest_delta_q12_4, velocity_q8_8, wrap_x_q12_4, wrap_y_q12_4,
};
use asteroids_verifier_core::sim::{AsteroidSizeSnapshot, AsteroidSnapshot, WorldSnapshot};
use asteroids_verifier_core::tape::{decode_input_byte, FrameInput};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HoldPhase {
    Rush,
    Setup,
    Farm,
}

#[derive(Clone, Copy, Debug)]
struct AnchorSnapshot {
    x: i32,
    y: i32,
    vx: i32,
    vy: i32,
    radius: i32,
    size: AsteroidSizeSnapshot,
}

impl From<&AsteroidSnapshot> for AnchorSnapshot {
    fn from(value: &AsteroidSnapshot) -> Self {
        Self {
            x: value.x,
            y: value.y,
            vx: value.vx,
            vy: value.vy,
            radius: value.radius,
            size: value.size,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct HoldTarget {
    aim_angle: i32,
    value: f64,
    intercept_frames: f64,
    target_x: i32,
    target_y: i32,
    target_vx: i32,
    target_vy: i32,
    target_radius: i32,
    is_saucer: bool,
    is_small_saucer: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct ShotCorridor {
    blocks_anchor: bool,
    blocks_other: bool,
    first_block_time: Option<f64>,
}

pub struct Wave7HoldBot {
    rush_bot: Box<dyn AutopilotBot>,
    phase: HoldPhase,
    anchor: Option<AnchorSnapshot>,
    wave7_entry_frame: Option<u32>,
}

impl Wave7HoldBot {
    pub fn new() -> Self {
        Self {
            rush_bot: create_bot("codex-rollout-sentinel")
                .unwrap_or_else(|| Box::new(PredatorBot::new())),
            phase: HoldPhase::Rush,
            anchor: None,
            wave7_entry_frame: None,
        }
    }

    fn alive_asteroid_count(world: &WorldSnapshot) -> usize {
        world.asteroids.iter().filter(|a| a.alive).count()
    }

    fn alive_saucer_count(world: &WorldSnapshot) -> usize {
        world.saucers.iter().filter(|s| s.alive).count()
    }

    fn update_phase(&mut self, world: &WorldSnapshot) {
        if world.wave < 7 {
            self.phase = HoldPhase::Rush;
            self.wave7_entry_frame = None;
            self.anchor = None;
            return;
        }

        self.wave7_entry_frame.get_or_insert(world.frame_count);
        self.refresh_anchor(world);
        self.phase = if Self::alive_asteroid_count(world) <= 1 {
            HoldPhase::Farm
        } else {
            HoldPhase::Setup
        };
    }

    fn should_use_farmer(&self, world: &WorldSnapshot) -> bool {
        world.wave >= 7 && Self::alive_asteroid_count(world) <= 3
    }

    fn refresh_anchor(&mut self, world: &WorldSnapshot) {
        let ship = PredictedShip::from_world(world);
        let previous = self.anchor;

        let best = world
            .asteroids
            .iter()
            .filter(|asteroid| asteroid.alive)
            .max_by(|left, right| {
                self.anchor_score(world, ship, left, previous)
                    .total_cmp(&self.anchor_score(world, ship, right, previous))
            });

        self.anchor = best.map(AnchorSnapshot::from);
    }

    fn anchor_score(
        &self,
        _world: &WorldSnapshot,
        ship: PredictedShip,
        asteroid: &AsteroidSnapshot,
        previous: Option<AnchorSnapshot>,
    ) -> f64 {
        let size_bias = match asteroid.size {
            AsteroidSizeSnapshot::Small => 240.0,
            AsteroidSizeSnapshot::Medium => 130.0,
            AsteroidSizeSnapshot::Large => 40.0,
        };

        let approach = torus_relative_approach(
            ship.x,
            ship.y,
            ship.vx,
            ship.vy,
            asteroid.x,
            asteroid.y,
            asteroid.vx,
            asteroid.vy,
            48.0,
        );
        let speed_px = ((asteroid.vx as f64 / 256.0).powi(2) + (asteroid.vy as f64 / 256.0).powi(2))
            .sqrt();

        let mut continuity = 0.0;
        if let Some(prev) = previous {
            let pos_delta = torus_distance_px(prev.x, prev.y, asteroid.x, asteroid.y);
            let vel_delta = (((prev.vx - asteroid.vx) as f64 / 256.0).powi(2)
                + ((prev.vy - asteroid.vy) as f64 / 256.0).powi(2))
            .sqrt();
            if prev.size == asteroid.size {
                continuity += 85.0;
            }
            continuity += ((180.0 - pos_delta).max(0.0) / 180.0) * 110.0;
            continuity += ((3.0 - vel_delta).max(0.0) / 3.0) * 24.0;
        }

        size_bias + approach.immediate_px * 0.72 + approach.closest_px * 0.45 - speed_px * 18.0
            + continuity
    }

    fn anchor_matches(&self, asteroid: &AsteroidSnapshot) -> bool {
        let Some(anchor) = self.anchor else {
            return false;
        };

        asteroid.x == anchor.x
            && asteroid.y == anchor.y
            && asteroid.vx == anchor.vx
            && asteroid.vy == anchor.vy
            && asteroid.radius == anchor.radius
            && asteroid.size == anchor.size
    }

    fn entity_risk(
        &self,
        pred: PredictedShip,
        ex: i32,
        ey: i32,
        evx: i32,
        evy: i32,
        radius: i32,
        weight: f64,
        lookahead: f64,
    ) -> f64 {
        let approach = torus_relative_approach(
            pred.x, pred.y, pred.vx, pred.vy, ex, ey, evx, evy, lookahead,
        );
        let safe = (pred.radius + radius + 8) as f64;
        let closest = (safe / (approach.closest_px + 1.0)).powf(2.05);
        let immediate = (safe / (approach.immediate_px + 1.0)).powf(1.38);
        let closing = if approach.dot < 0.0 { 1.28 } else { 0.92 };
        let time_boost = 1.0 + ((lookahead - approach.t_closest) / lookahead.max(1.0)) * 0.42;
        weight * (0.76 * closest + 0.24 * immediate) * closing * time_boost
    }

    fn planned_bullet(pred: PredictedShip) -> (i32, i32, i32, i32) {
        let (dx, dy) = displace_q12_4(pred.angle, pred.radius + 6);
        let start_x = wrap_x_q12_4(pred.x + dx);
        let start_y = wrap_y_q12_4(pred.y + dy);
        let ship_speed_approx = ((pred.vx.abs() + pred.vy.abs()) * 3) >> 2;
        let bullet_speed_q8_8 = SHIP_BULLET_SPEED_Q8_8 + ((ship_speed_approx * 89) >> 8);
        let (bvx, bvy) = velocity_q8_8(pred.angle, bullet_speed_q8_8);
        (start_x, start_y, pred.vx + bvx, pred.vy + bvy)
    }

    fn shot_corridor(
        &self,
        world: &WorldSnapshot,
        pred: PredictedShip,
        target: HoldTarget,
    ) -> ShotCorridor {
        if !target.is_saucer {
            return ShotCorridor::default();
        }

        let (start_x, start_y, bullet_vx, bullet_vy) = Self::planned_bullet(pred);
        let horizon = (target.intercept_frames + 10.0).clamp(1.0, SHIP_BULLET_LIFETIME_FRAMES as f64);
        let (target_closest, target_t) = projectile_wrap_closest_approach(
            start_x,
            start_y,
            bullet_vx,
            bullet_vy,
            target.target_x,
            target.target_y,
            target.target_vx,
            target.target_vy,
            horizon,
        );
        let target_hit_time = if target_closest <= (target.target_radius + 3) as f64 {
            target_t
        } else {
            target.intercept_frames
        };

        let mut corridor = ShotCorridor::default();

        for asteroid in &world.asteroids {
            if !asteroid.alive {
                continue;
            }
            let block_horizon =
                (target_hit_time + 4.0).clamp(1.0, SHIP_BULLET_LIFETIME_FRAMES as f64);
            let (closest, t) = projectile_wrap_closest_approach(
                start_x,
                start_y,
                bullet_vx,
                bullet_vy,
                asteroid.x,
                asteroid.y,
                asteroid.vx,
                asteroid.vy,
                block_horizon,
            );
            if closest > (asteroid.radius + 3) as f64 || t > target_hit_time + 0.75 {
                continue;
            }

            corridor.first_block_time = match corridor.first_block_time {
                None => Some(t),
                Some(existing) if t < existing => Some(t),
                Some(existing) => Some(existing),
            };
            if self.anchor_matches(asteroid) {
                corridor.blocks_anchor = true;
            } else {
                corridor.blocks_other = true;
            }
        }

        corridor
    }

    fn best_hold_target(&self, world: &WorldSnapshot, pred: PredictedShip) -> Option<HoldTarget> {
        let asteroid_count = Self::alive_asteroid_count(world);
        let saucer_count = Self::alive_saucer_count(world);
        let bullet_speed = 8.6 + pred.speed_px() * 0.33;
        let in_lurk = world.time_since_last_kill >= LURK_TIME_THRESHOLD_FRAMES;
        let mut best: Option<HoldTarget> = None;

        let mut consider = |x: i32,
                            y: i32,
                            vx: i32,
                            vy: i32,
                            radius: i32,
                            weight: f64,
                            is_saucer: bool,
                            is_small_saucer: bool| {
            if weight <= 0.0 {
                return;
            }

            let Some(intercept) = best_wrapped_aim(
                pred.x,
                pred.y,
                pred.vx,
                pred.vy,
                pred.angle,
                x,
                y,
                vx,
                vy,
                bullet_speed,
                72.0,
            ) else {
                return;
            };

            let angle_error = signed_angle_delta(pred.angle, intercept.aim_angle).abs() as f64;
            let mut value = weight / (intercept.distance_px + 18.0);
            value += (1.0 - (angle_error / 128.0)).max(0.0) * 0.72;
            value *= 1.0 + (1.0 - (intercept.intercept_frames / 72.0).clamp(0.0, 1.0)) * 0.16;

            if is_saucer && intercept.distance_px < 260.0 {
                value *= 1.22;
            }
            if is_small_saucer {
                value *= 1.35;
            }
            if is_small_saucer && in_lurk {
                value *= 1.16;
            }
            if self.phase == HoldPhase::Farm && is_saucer {
                value *= 1.58;
            }
            if self.phase == HoldPhase::Setup && saucer_count == 0 && asteroid_count <= 3 {
                value *= 1.08;
            }

            let mut candidate = HoldTarget {
                aim_angle: intercept.aim_angle,
                value,
                intercept_frames: intercept.intercept_frames,
                target_x: x,
                target_y: y,
                target_vx: vx,
                target_vy: vy,
                target_radius: radius,
                is_saucer,
                is_small_saucer,
            };

            if is_saucer {
                let corridor = self.shot_corridor(world, pred, candidate);
                if corridor.blocks_anchor {
                    candidate.value *= if asteroid_count <= 1 { 0.08 } else { 0.28 };
                } else if corridor.blocks_other {
                    candidate.value *= if asteroid_count <= 1 { 0.4 } else { 0.82 };
                } else {
                    candidate.value *= 1.08;
                }
                if asteroid_count <= 1 && !is_small_saucer {
                    candidate.value *= 0.58;
                }
            }

            match best {
                None => best = Some(candidate),
                Some(current) if candidate.value > current.value => best = Some(candidate),
                _ => {}
            }
        };

        for saucer in &world.saucers {
            if !saucer.alive {
                continue;
            }
            let mut weight = if saucer.small {
                match self.phase {
                    HoldPhase::Setup => 7.1,
                    HoldPhase::Farm => 10.2,
                    HoldPhase::Rush => 4.6,
                }
            } else {
                match self.phase {
                    HoldPhase::Setup => 2.8,
                    HoldPhase::Farm => {
                        if asteroid_count <= 1 {
                            2.1
                        } else {
                            3.8
                        }
                    }
                    HoldPhase::Rush => 2.2,
                }
            };
            if saucer_count >= 2 && saucer.small {
                weight *= 1.08;
            }
            consider(
                saucer.x,
                saucer.y,
                saucer.vx,
                saucer.vy,
                saucer.radius,
                weight,
                true,
                saucer.small,
            );
        }

        if self.phase == HoldPhase::Farm && asteroid_count <= 1 && saucer_count > 0 {
            return best;
        }

        for asteroid in &world.asteroids {
            if !asteroid.alive || self.anchor_matches(asteroid) {
                continue;
            }

            let mut weight = match self.phase {
                HoldPhase::Setup => match asteroid.size {
                    AsteroidSizeSnapshot::Large => 1.95,
                    AsteroidSizeSnapshot::Medium => 2.55,
                    AsteroidSizeSnapshot::Small => 3.05,
                },
                HoldPhase::Farm => {
                    if asteroid_count > 1 {
                        match asteroid.size {
                            AsteroidSizeSnapshot::Large => 1.4,
                            AsteroidSizeSnapshot::Medium => 1.9,
                            AsteroidSizeSnapshot::Small => 2.25,
                        }
                    } else {
                        0.0
                    }
                }
                HoldPhase::Rush => 0.0,
            };

            if saucer_count > 0 {
                weight *= 0.72;
            }
            consider(
                asteroid.x,
                asteroid.y,
                asteroid.vx,
                asteroid.vy,
                asteroid.radius,
                weight,
                false,
                false,
            );
        }

        best
    }

    fn shot_threatens_anchor(
        &self,
        pred: PredictedShip,
        target: HoldTarget,
        anchor: AnchorSnapshot,
    ) -> bool {
        let (start_x, start_y, bullet_vx, bullet_vy) = Self::planned_bullet(pred);
        let horizon = (target.intercept_frames + 14.0).clamp(1.0, SHIP_BULLET_LIFETIME_FRAMES as f64);
        let (closest, t) = projectile_wrap_closest_approach(
            start_x,
            start_y,
            bullet_vx,
            bullet_vy,
            anchor.x,
            anchor.y,
            anchor.vx,
            anchor.vy,
            horizon,
        );
        closest <= (anchor.radius + 5) as f64 && t <= horizon
    }

    fn evaluate_action(&self, world: &WorldSnapshot, action: u8) -> f64 {
        let pred = predict_ship(world, action);
        let input = decode_input_byte(action);
        let asteroid_count = Self::alive_asteroid_count(world);
        let saucer_count = Self::alive_saucer_count(world);
        let has_saucers = saucer_count > 0;
        let only_anchor_left = asteroid_count <= 1;
        let near_lurk = world.time_since_last_kill >= 300;
        let in_lurk = world.time_since_last_kill >= LURK_TIME_THRESHOLD_FRAMES;
        let lookahead = if self.phase == HoldPhase::Farm { 22.0 } else { 19.0 };

        let mut risk = 0.0;
        for asteroid in &world.asteroids {
            if !asteroid.alive {
                continue;
            }
            let weight = if self.anchor_matches(asteroid) && self.phase == HoldPhase::Farm {
                1.55
            } else if self.phase == HoldPhase::Farm {
                1.4
            } else {
                1.28
            };
            risk += self.entity_risk(
                pred,
                asteroid.x,
                asteroid.y,
                asteroid.vx,
                asteroid.vy,
                asteroid.radius,
                weight,
                lookahead,
            );
        }
        for saucer in &world.saucers {
            if !saucer.alive {
                continue;
            }
            let weight = if saucer.small {
                if self.phase == HoldPhase::Farm {
                    2.85
                } else {
                    2.55
                }
            } else if self.phase == HoldPhase::Farm {
                2.25
            } else {
                2.05
            };
            risk += self.entity_risk(
                pred,
                saucer.x,
                saucer.y,
                saucer.vx,
                saucer.vy,
                saucer.radius,
                weight,
                lookahead,
            );
        }
        for bullet in &world.saucer_bullets {
            if !bullet.alive {
                continue;
            }
            risk += self.entity_risk(
                pred,
                bullet.x,
                bullet.y,
                bullet.vx,
                bullet.vy,
                bullet.radius,
                if self.phase == HoldPhase::Farm { 3.1 } else { 2.9 },
                lookahead,
            );
        }

        let target = self.best_hold_target(world, pred);
        let mut attack_term = 0.0;
        let mut fire_term = 0.0;

        if let Some(target) = target {
            let angle_error = signed_angle_delta(pred.angle, target.aim_angle).abs() as f64;
            let align = (1.0 - (angle_error / 128.0)).clamp(0.0, 1.0);
            let mut aggression = if target.is_saucer {
                if target.is_small_saucer {
                    1.28
                } else {
                    1.02
                }
            } else if self.phase == HoldPhase::Setup {
                1.08
            } else {
                0.82
            };

            if self.phase == HoldPhase::Farm && target.is_saucer {
                aggression *= 1.24;
            }
            if near_lurk && !has_saucers && self.phase == HoldPhase::Setup {
                aggression *= 1.08;
            }

            attack_term += target.value * align * aggression;

            if input.fire && world.bullets.len() < SHIP_BULLET_LIMIT && pred.fire_cooldown <= 0 {
                let hard_hold = self.phase == HoldPhase::Farm && only_anchor_left && !has_saucers;
                let fire_quality = estimate_fire_quality(pred, world);
                let (active, shortest) = own_bullet_stats(&world.bullets);
                let nearest_saucer = nearest_saucer_distance(world, pred);
                let nearest_threat = nearest_threat_distance(world, pred.x, pred.y);
                let is_duplicate = target_already_covered(
                    &world.bullets,
                    target.target_x,
                    target.target_y,
                    target.target_vx,
                    target.target_vy,
                    target.target_radius,
                );
                let min_quality = if target.is_saucer {
                    if target.is_small_saucer { 0.1 } else { 0.14 }
                } else if asteroid_count <= 2 {
                    0.22
                } else {
                    0.17
                };
                let discipline_ok = disciplined_fire_ok(
                    active,
                    shortest,
                    fire_quality,
                    min_quality,
                    nearest_saucer,
                    nearest_threat,
                    is_duplicate,
                );
                let anchor_safe = self
                    .anchor
                    .map(|anchor| !self.shot_threatens_anchor(pred, target, anchor))
                    .unwrap_or(true);
                let corridor = if target.is_saucer {
                    Some(self.shot_corridor(world, pred, target))
                } else {
                    None
                };
                let corridor_safe = corridor.map(|c| {
                    if only_anchor_left {
                        !c.blocks_anchor && !c.blocks_other
                    } else {
                        !c.blocks_anchor && !(asteroid_count <= 3 && c.blocks_other)
                    }
                }).unwrap_or(true);
                let large_saucer_ok =
                    target.is_small_saucer || !only_anchor_left || nearest_threat < 105.0;
                let emergency_saucer =
                    target.is_saucer && nearest_saucer < 95.0 && fire_quality + 0.08 >= min_quality;

                if hard_hold {
                    fire_term -= 1.6;
                } else if !is_duplicate
                    && anchor_safe
                    && corridor_safe
                    && large_saucer_ok
                    && discipline_ok
                    && (fire_quality >= min_quality || emergency_saucer)
                {
                    let fire_align = (1.0 - (angle_error / 8.0)).clamp(0.0, 1.0);
                    fire_term += 1.32 * fire_align * (0.38 + 0.62 * fire_quality);
                    fire_term -= 0.48;
                    if target.is_small_saucer {
                        fire_term += 0.28;
                    }
                    if in_lurk && target.is_saucer {
                        fire_term += 0.2;
                    }
                } else if is_duplicate {
                    fire_term -= 0.7;
                } else if !anchor_safe {
                    fire_term -= 1.1;
                } else if !corridor_safe {
                    fire_term -= 0.95;
                } else if !large_saucer_ok {
                    fire_term -= 0.7;
                } else {
                    fire_term -= 0.18;
                }
            }
        } else if input.fire {
            fire_term -= 1.15;
        }

        let cx =
            shortest_delta_q12_4(pred.x, WORLD_WIDTH_Q12_4 / 2, WORLD_WIDTH_Q12_4) as f64 / 16.0;
        let cy = shortest_delta_q12_4(pred.y, WORLD_HEIGHT_Q12_4 / 2, WORLD_HEIGHT_Q12_4) as f64
            / 16.0;
        let center_dist = (cx * cx + cy * cy).sqrt();
        let center_weight = if self.phase == HoldPhase::Farm { 0.56 } else { 0.38 };
        let center_term = -(center_dist / 900.0) * center_weight;

        let left_edge = pred.x as f64 / 16.0;
        let right_edge = (WORLD_WIDTH_Q12_4 - pred.x) as f64 / 16.0;
        let top_edge = pred.y as f64 / 16.0;
        let bottom_edge = (WORLD_HEIGHT_Q12_4 - pred.y) as f64 / 16.0;
        let min_edge = left_edge.min(right_edge).min(top_edge).min(bottom_edge);
        let edge_penalty = if self.phase == HoldPhase::Farm { 0.38 } else { 0.28 };
        let edge_term = -((135.0 - min_edge).max(0.0) / 135.0) * edge_penalty;

        let speed_px = pred.speed_px();
        let speed_soft_cap = if self.phase == HoldPhase::Farm { 4.15 } else { 4.65 };
        let speed_term = if speed_px > speed_soft_cap {
            -((speed_px - speed_soft_cap) / speed_soft_cap) * 0.34
        } else {
            0.0
        };

        let anchor_term = if let Some(anchor) = self.anchor {
            let anchor_dist = torus_distance_px(pred.x, pred.y, anchor.x, anchor.y);
            let desired = if has_saucers { 210.0 } else { 280.0 };
            let slack = if has_saucers { 150.0 } else { 190.0 };
            let mut term = -((anchor_dist - desired).abs() / slack).min(1.6) * 0.24;
            if anchor_dist < 120.0 {
                term -= ((120.0 - anchor_dist) / 120.0) * 0.95;
            }
            term
        } else {
            0.0
        };

        let nearest_threat = nearest_threat_distance(world, pred.x, pred.y);
        let control_scale = if risk > 3.0 {
            0.18
        } else if risk > 1.8 {
            0.42
        } else {
            1.0
        };
        let mut control_term = 0.0;
        if action != 0 {
            control_term -= 0.01 * control_scale;
        }
        if input.left || input.right {
            control_term -= 0.011 * control_scale;
        }
        if input.thrust {
            control_term -= 0.01 * control_scale;
        } else if action == 0x00 && nearest_threat > 170.0 {
            control_term += 0.002;
        }
        if self.phase == HoldPhase::Farm && only_anchor_left && !has_saucers && input.fire {
            control_term -= 1.5;
        }

        let survival_weight = if self.phase == HoldPhase::Farm { 2.2 } else { 1.92 };
        -risk * survival_weight
            + attack_term
            + fire_term
            + control_term
            + center_term
            + edge_term
            + speed_term
            + anchor_term
    }
}

impl Default for Wave7HoldBot {
    fn default() -> Self {
        Self::new()
    }
}

impl AutopilotBot for Wave7HoldBot {
    fn id(&self) -> &'static str {
        "claude-wave7-hold"
    }

    fn description(&self) -> &'static str {
        "Rushes to wave 7, preserves one asteroid, and farms small saucers."
    }

    fn reset(&mut self, seed: u32) {
        self.rush_bot.reset(seed);
        self.phase = HoldPhase::Rush;
        self.anchor = None;
        self.wave7_entry_frame = None;
    }

    fn next_input(&mut self, world: &WorldSnapshot) -> FrameInput {
        if world.is_game_over || !world.ship.can_control {
            return FrameInput {
                left: false,
                right: false,
                thrust: false,
                fire: false,
            };
        }

        self.update_phase(world);
        if !self.should_use_farmer(world) || self.phase == HoldPhase::Rush {
            return self.rush_bot.next_input(world);
        }

        let mut best_action = 0x00u8;
        let mut best_value = f64::NEG_INFINITY;
        for action in 0x00u8..=0x0F {
            let utility = self.evaluate_action(world, action);
            if utility > best_value {
                best_value = utility;
                best_action = action;
            }
        }
        decode_input_byte(best_action)
    }
}
