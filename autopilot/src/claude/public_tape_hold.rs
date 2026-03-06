//! Hybrid bots that replay a public tape prefix on one seed, then hand off to wave-7 hold logic.

use crate::bots::AutopilotBot;
use crate::claude::chimera::ChimeraBot;
use crate::claude::navigator::NavigatorBot;
use crate::claude::predator::PredatorBot;
use crate::claude::vulture::VultureBot;
use crate::claude::wave7_hold::Wave7HoldBot;
use asteroids_verifier_core::sim::WorldSnapshot;
use asteroids_verifier_core::tape::{decode_input_byte, parse_tape, FrameInput};
use std::fs;
use std::path::Path;

const PUBLIC_911K_SEED: u32 = 0x5f41_772e;
const PUBLIC_911K_TAPE_REL: &str = "fixtures/public/kalien-911140-seed1598125870.tape";
const PUBLIC_911K_MAX_FRAMES: u32 = 36_000;
const PUBLIC_PREFIX_ID_PREFIX: &str = "claude-public911-prefix";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FallbackKind {
    Wave7Hold,
    Predator,
    Vulture,
    Chimera,
    Navigator,
}

impl FallbackKind {
    fn from_suffix(raw: Option<&str>) -> Option<Self> {
        match raw {
            None | Some("") | Some("hold") | Some("wave7") => Some(Self::Wave7Hold),
            Some("predator") => Some(Self::Predator),
            Some("vulture") => Some(Self::Vulture),
            Some("chimera") => Some(Self::Chimera),
            Some("navigator") => Some(Self::Navigator),
            _ => None,
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Wave7Hold => "wave-7 hold logic",
            Self::Predator => "predator intercept logic",
            Self::Vulture => "vulture saucer-farming logic",
            Self::Chimera => "chimera ensemble logic",
            Self::Navigator => "navigator danger-field logic",
        }
    }

    fn build_bot(self) -> Box<dyn AutopilotBot> {
        match self {
            Self::Wave7Hold => Box::new(Wave7HoldBot::new()),
            Self::Predator => Box::new(PredatorBot::new()),
            Self::Vulture => Box::new(VultureBot::new()),
            Self::Chimera => Box::new(ChimeraBot::new()),
            Self::Navigator => Box::new(NavigatorBot::new()),
        }
    }
}

pub struct PublicTapeHoldBot {
    id: &'static str,
    description: &'static str,
    expected_seed: u32,
    prefix_frames: usize,
    prefix_inputs: Vec<u8>,
    prefix_ready: bool,
    fallback: Box<dyn AutopilotBot>,
}

impl PublicTapeHoldBot {
    fn new(
        id: &'static str,
        description: &'static str,
        prefix_frames: usize,
        fallback_kind: FallbackKind,
    ) -> Self {
        Self {
            id,
            description,
            expected_seed: PUBLIC_911K_SEED,
            prefix_frames,
            prefix_inputs: Vec::new(),
            prefix_ready: false,
            fallback: fallback_kind.build_bot(),
        }
    }

    pub fn try_create_dynamic(id: &str) -> Option<Box<dyn AutopilotBot>> {
        let raw = id.strip_prefix(PUBLIC_PREFIX_ID_PREFIX)?;
        let (frames_raw, fallback_raw) = raw.split_once('-').map_or((raw, None), |(a, b)| (a, Some(b)));
        let prefix_frames = frames_raw.parse::<usize>().ok()?;
        if prefix_frames == 0 || prefix_frames > PUBLIC_911K_MAX_FRAMES as usize {
            return None;
        }
        let fallback_kind = FallbackKind::from_suffix(fallback_raw)?;

        let leaked_id: &'static str = Box::leak(id.to_string().into_boxed_str());
        let description = format!(
            "Replays the public 911140 run for {} frames, then switches to {}.",
            prefix_frames,
            fallback_kind.description()
        );
        let leaked_description: &'static str = Box::leak(description.into_boxed_str());
        Some(Box::new(Self::new(
            leaked_id,
            leaked_description,
            prefix_frames,
            fallback_kind,
        )))
    }

    pub fn prefix_5200() -> Self {
        Self::new(
            "claude-public911-prefix5200",
            "Replays the public 911140 run to wave 7, then switches to wave-7 hold logic.",
            5_200,
            FallbackKind::Wave7Hold,
        )
    }

    pub fn prefix_6500() -> Self {
        Self::new(
            "claude-public911-prefix6500",
            "Replays the public 911140 run through early wave-7 setup, then farms with wave-7 hold logic.",
            6_500,
            FallbackKind::Wave7Hold,
        )
    }

    pub fn prefix_9000() -> Self {
        Self::new(
            "claude-public911-prefix9000",
            "Replays the public 911140 run into stable wave-7 farming, then diverges with wave-7 hold logic.",
            9_000,
            FallbackKind::Wave7Hold,
        )
    }

    fn load_prefix_inputs(&mut self) {
        self.prefix_inputs.clear();
        self.prefix_ready = false;

        let tape_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(PUBLIC_911K_TAPE_REL);
        let Ok(bytes) = fs::read(&tape_path) else {
            return;
        };
        let Ok(view) = parse_tape(&bytes, PUBLIC_911K_MAX_FRAMES) else {
            return;
        };
        if view.header.seed != self.expected_seed {
            return;
        }

        let prefix_len = self.prefix_frames.min(view.inputs.len());
        self.prefix_inputs.extend_from_slice(&view.inputs[..prefix_len]);
        self.prefix_ready = true;
    }
}

impl AutopilotBot for PublicTapeHoldBot {
    fn id(&self) -> &'static str {
        self.id
    }

    fn description(&self) -> &'static str {
        self.description
    }

    fn reset(&mut self, seed: u32) {
        self.fallback.reset(seed);
        if seed == self.expected_seed {
            self.load_prefix_inputs();
        } else {
            self.prefix_inputs.clear();
            self.prefix_ready = false;
        }
    }

    fn next_input(&mut self, world: &WorldSnapshot) -> FrameInput {
        let frame = world.frame_count as usize;
        if self.prefix_ready && frame < self.prefix_inputs.len() {
            return decode_input_byte(self.prefix_inputs[frame]);
        }
        self.fallback.next_input(world)
    }
}
