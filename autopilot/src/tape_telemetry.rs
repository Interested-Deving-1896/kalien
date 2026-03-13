use anyhow::{anyhow, Result};
use asteroids_verifier_core::sim::LiveGame;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct FrameTelemetry {
    pub frame: u32,
    pub score: u32,
    pub score_delta: u32,
    pub wave: i32,
    pub lives: i32,
    pub time_since_last_kill: i32,
    pub asteroid_count: usize,
    pub saucer_count: usize,
    pub small_saucer_count: usize,
    pub bullet_count: usize,
    pub saucer_bullet_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct WaveTelemetry {
    pub wave: i32,
    pub enter_frame: u32,
    pub exit_frame: Option<u32>,
    pub enter_score: u32,
    pub exit_score: Option<u32>,
    pub frames: u32,
    pub score_delta: u32,
    pub frames_with_one_asteroid: u32,
    pub frames_with_three_saucers: u32,
    pub frames_with_three_small_saucers: u32,
    pub max_asteroids: usize,
    pub min_asteroids: usize,
    pub max_saucers: usize,
    pub max_small_saucers: usize,
    pub delta_990_frames: u32,
    pub delta_1980_frames: u32,
    pub estimated_small_saucer_kills: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct TapeTelemetryReport {
    pub seed: u32,
    pub max_frames: u32,
    pub frame_count: u32,
    pub final_score: u32,
    pub final_wave: i32,
    pub final_lives: i32,
    pub wave7_enter_frame: Option<u32>,
    pub wave7_enter_score: Option<u32>,
    pub first_wave_gt7_frame: Option<u32>,
    pub first_wave_gt7_score: Option<u32>,
    pub first_zero_asteroid_on_wave7_frame: Option<u32>,
    pub first_zero_asteroid_on_wave7_score: Option<u32>,
    pub delta_990_frames: u32,
    pub delta_1980_frames: u32,
    pub estimated_small_saucer_kills: u32,
    pub waves: Vec<WaveTelemetry>,
    pub frames: Vec<FrameTelemetry>,
}

pub fn analyze_tape_inputs(
    seed: u32,
    max_frames: u32,
    inputs: &[u8],
    sample_every: u32,
) -> Result<TapeTelemetryReport> {
    if sample_every == 0 {
        return Err(anyhow!("sample_every must be >= 1"));
    }

    let mut game = LiveGame::new(seed);
    game.validate()
        .map_err(|rule| anyhow!("initial invariant failure for tape telemetry: {rule:?}"))?;

    let mut snapshot = game.snapshot();
    let mut frames = Vec::new();
    let mut waves = Vec::<WaveTelemetry>::new();
    let mut active_wave: Option<WaveTelemetry> = None;

    let mut wave7_enter_frame = None;
    let mut wave7_enter_score = None;
    let mut first_wave_gt7_frame = None;
    let mut first_wave_gt7_score = None;
    let mut first_zero_asteroid_on_wave7_frame = None;
    let mut first_zero_asteroid_on_wave7_score = None;
    let mut delta_990_frames = 0u32;
    let mut delta_1980_frames = 0u32;

    for input in inputs.iter().copied() {
        let before = snapshot.clone();
        game.step(input);
        snapshot = game.snapshot();

        let frame = snapshot.frame_count;
        let score_delta = snapshot.score.saturating_sub(before.score);
        let asteroid_count = snapshot.asteroids.iter().filter(|a| a.alive).count();
        let saucer_count = snapshot.saucers.iter().filter(|s| s.alive).count();
        let small_saucer_count = snapshot
            .saucers
            .iter()
            .filter(|s| s.alive && s.small)
            .count();
        let bullet_count = snapshot.bullets.iter().filter(|b| b.alive).count();
        let saucer_bullet_count = snapshot.saucer_bullets.iter().filter(|b| b.alive).count();

        if score_delta == 990 {
            delta_990_frames = delta_990_frames.saturating_add(1);
        } else if score_delta == 1_980 {
            delta_1980_frames = delta_1980_frames.saturating_add(1);
        }

        let wave_changed = active_wave
            .as_ref()
            .map(|wave| wave.wave != snapshot.wave)
            .unwrap_or(true);
        if wave_changed {
            if let Some(mut finished) = active_wave.take() {
                finished.exit_frame = Some(frame.saturating_sub(1));
                finished.exit_score = Some(before.score);
                finished.score_delta = before.score.saturating_sub(finished.enter_score);
                finished.estimated_small_saucer_kills = finished
                    .delta_990_frames
                    .saturating_add(finished.delta_1980_frames.saturating_mul(2));
                waves.push(finished);
            }

            active_wave = Some(WaveTelemetry {
                wave: snapshot.wave,
                enter_frame: frame,
                exit_frame: None,
                enter_score: snapshot.score,
                exit_score: None,
                frames: 0,
                score_delta: 0,
                frames_with_one_asteroid: 0,
                frames_with_three_saucers: 0,
                frames_with_three_small_saucers: 0,
                max_asteroids: asteroid_count,
                min_asteroids: asteroid_count,
                max_saucers: saucer_count,
                max_small_saucers: small_saucer_count,
                delta_990_frames: 0,
                delta_1980_frames: 0,
                estimated_small_saucer_kills: 0,
            });
        }

        let wave = active_wave
            .as_mut()
            .expect("active wave should exist after initialization");
        wave.frames = wave.frames.saturating_add(1);
        if asteroid_count == 1 {
            wave.frames_with_one_asteroid = wave.frames_with_one_asteroid.saturating_add(1);
        }
        if saucer_count == 3 {
            wave.frames_with_three_saucers = wave.frames_with_three_saucers.saturating_add(1);
        }
        if small_saucer_count == 3 {
            wave.frames_with_three_small_saucers =
                wave.frames_with_three_small_saucers.saturating_add(1);
        }
        wave.max_asteroids = wave.max_asteroids.max(asteroid_count);
        wave.min_asteroids = wave.min_asteroids.min(asteroid_count);
        wave.max_saucers = wave.max_saucers.max(saucer_count);
        wave.max_small_saucers = wave.max_small_saucers.max(small_saucer_count);
        if score_delta == 990 {
            wave.delta_990_frames = wave.delta_990_frames.saturating_add(1);
        } else if score_delta == 1_980 {
            wave.delta_1980_frames = wave.delta_1980_frames.saturating_add(1);
        }

        if snapshot.wave == 7 && wave7_enter_frame.is_none() {
            wave7_enter_frame = Some(frame);
            wave7_enter_score = Some(snapshot.score);
        }
        if before.wave == 7 && snapshot.wave > 7 && first_wave_gt7_frame.is_none() {
            first_wave_gt7_frame = Some(frame);
            first_wave_gt7_score = Some(snapshot.score);
        }
        if snapshot.wave == 7 && asteroid_count == 0 && first_zero_asteroid_on_wave7_frame.is_none()
        {
            first_zero_asteroid_on_wave7_frame = Some(frame);
            first_zero_asteroid_on_wave7_score = Some(snapshot.score);
        }

        if frame.is_multiple_of(sample_every) || frame == inputs.len() as u32 {
            frames.push(FrameTelemetry {
                frame,
                score: snapshot.score,
                score_delta,
                wave: snapshot.wave,
                lives: snapshot.lives,
                time_since_last_kill: snapshot.time_since_last_kill,
                asteroid_count,
                saucer_count,
                small_saucer_count,
                bullet_count,
                saucer_bullet_count,
            });
        }

        if snapshot.is_game_over || frame >= max_frames {
            break;
        }
    }

    if let Some(mut finished) = active_wave.take() {
        finished.exit_frame = Some(snapshot.frame_count);
        finished.exit_score = Some(snapshot.score);
        finished.score_delta = snapshot.score.saturating_sub(finished.enter_score);
        finished.estimated_small_saucer_kills = finished
            .delta_990_frames
            .saturating_add(finished.delta_1980_frames.saturating_mul(2));
        waves.push(finished);
    }

    Ok(TapeTelemetryReport {
        seed,
        max_frames,
        frame_count: snapshot.frame_count,
        final_score: snapshot.score,
        final_wave: snapshot.wave,
        final_lives: snapshot.lives,
        wave7_enter_frame,
        wave7_enter_score,
        first_wave_gt7_frame,
        first_wave_gt7_score,
        first_zero_asteroid_on_wave7_frame,
        first_zero_asteroid_on_wave7_score,
        delta_990_frames,
        delta_1980_frames,
        estimated_small_saucer_kills: delta_990_frames
            .saturating_add(delta_1980_frames.saturating_mul(2)),
        waves,
        frames,
    })
}
