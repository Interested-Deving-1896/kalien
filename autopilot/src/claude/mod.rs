pub mod chimera;
pub mod common;
pub mod lab;
pub mod navigator;
pub mod oracle;
pub mod phoenix;
pub mod predator;
pub mod public_tape_hold;
pub mod tortoise;
pub mod vulture;
pub mod wave7_hold;

use crate::bots::AutopilotBot;
use std::path::PathBuf;

pub fn bot_ids() -> Vec<&'static str> {
    vec![
        "claude-phoenix",
        "claude-navigator",
        "claude-vulture",
        "claude-wave7-hold",
        "claude-public911-prefix5200",
        "claude-public911-prefix6500",
        "claude-public911-prefix9000",
        "claude-tortoise",
        "claude-oracle",
        "claude-predator",
        "claude-chimera",
    ]
}

pub fn describe_bots() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "claude-phoenix",
            "Adaptive phase bot: aggressive early, balanced mid, survival late.",
        ),
        (
            "claude-navigator",
            "Danger-field navigator using spatial gradient descent for safe positioning.",
        ),
        (
            "claude-vulture",
            "Saucer farmer exploiting anti-lurk mechanic for high-value kills.",
        ),
        (
            "claude-wave7-hold",
            "Rushes to wave 7, preserves one asteroid, and farms small saucers.",
        ),
        (
            "claude-public911-prefix5200",
            "Replays the public 911140 run to wave 7, then switches to wave-7 hold logic.",
        ),
        (
            "claude-public911-prefix6500",
            "Replays the public 911140 run through early wave-7 setup, then farms with wave-7 hold logic.",
        ),
        (
            "claude-public911-prefix9000",
            "Replays the public 911140 run into stable wave-7 farming, then diverges with wave-7 hold logic.",
        ),
        (
            "claude-tortoise",
            "Ultra-conservative deep survival bot prioritizing dodging over scoring.",
        ),
        (
            "claude-oracle",
            "MCTS planner with UCB1 selection and rollout-based evaluation.",
        ),
        (
            "claude-predator",
            "Intercept chain optimizer planning multi-target kill sequences.",
        ),
        (
            "claude-chimera",
            "Ensemble hybrid weighting sub-strategies by threat level.",
        ),
    ]
}

pub fn create_bot(id: &str) -> Option<Box<dyn AutopilotBot>> {
    match id {
        "claude-phoenix" => Some(Box::new(phoenix::PhoenixBot::new())),
        "claude-navigator" => Some(Box::new(navigator::NavigatorBot::new())),
        "claude-vulture" => Some(Box::new(vulture::VultureBot::new())),
        "claude-wave7-hold" => Some(Box::new(wave7_hold::Wave7HoldBot::new())),
        "claude-public911-prefix5200" => {
            Some(Box::new(public_tape_hold::PublicTapeHoldBot::prefix_5200()))
        }
        "claude-public911-prefix6500" => {
            Some(Box::new(public_tape_hold::PublicTapeHoldBot::prefix_6500()))
        }
        "claude-public911-prefix9000" => {
            Some(Box::new(public_tape_hold::PublicTapeHoldBot::prefix_9000()))
        }
        "claude-tortoise" => Some(Box::new(tortoise::TortoiseBot::new())),
        "claude-oracle" => Some(Box::new(oracle::OracleBot::new())),
        "claude-predator" => Some(Box::new(predator::PredatorBot::new())),
        "claude-chimera" => Some(Box::new(chimera::ChimeraBot::new())),
        _ => public_tape_hold::PublicTapeHoldBot::try_create_dynamic(id)
            .or_else(|| try_load_evolved_bot(id)),
    }
}

/// Try loading an evolved bot from a JSON config file.
/// Supports: "evolved:<path>" to load from an explicit path.
fn try_load_evolved_bot(id: &str) -> Option<Box<dyn AutopilotBot>> {
    let path = if let Some(path_str) = id.strip_prefix("evolved:") {
        PathBuf::from(path_str)
    } else {
        return None;
    };
    lab::EvolvedBot::from_file(&path)
        .ok()
        .map(|bot| Box::new(bot) as Box<dyn AutopilotBot>)
}
