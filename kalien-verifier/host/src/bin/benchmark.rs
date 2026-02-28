use std::{env, fs, path::PathBuf, process};

use anyhow::{anyhow, Context, Result};
use asteroids_verifier_core::{
    constants::MAX_FRAMES_DEFAULT, decode_journal_raw, encode_claimant_for_journal,
    tape::parse_tape, VerificationJournal,
};
use host::SEGMENT_LIMIT_PO2_DEFAULT;
use methods::VERIFY_TAPE_ELF;
use risc0_zkvm::{default_executor, ExecutorEnv};
use serde::Serialize;

#[derive(Debug)]
struct Cli {
    tape_path: PathBuf,
    max_frames: u32,
    segment_limit_po2: u32,
    json_out: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct BenchmarkJson {
    seed: u32,
    seed_id: u32,
    frame_count: u32,
    final_score: u32,
    claimant: String,
    segments: u64,
    total_cycles: u64,
    cycles_per_frame: u64,
}

/// Pad a byte vector to a 4-byte boundary for guest `read_slice` alignment.
#[inline]
fn pad_to_word_boundary(mut data: Vec<u8>) -> Vec<u8> {
    let pad_len = (4 - (data.len() & 3)) & 3;
    if pad_len != 0 {
        data.resize(data.len() + pad_len, 0);
    }
    data
}

impl Cli {
    /// Parse benchmark CLI arguments.
    ///
    /// Required:
    /// - `--tape <path>`
    ///
    /// Optional:
    /// - `--max-frames`
    /// - `--segment-limit-po2`
    /// - `--json-out`
    fn parse() -> Result<Self> {
        let mut args = env::args().skip(1);
        let mut tape_path: Option<PathBuf> = None;
        let mut max_frames = MAX_FRAMES_DEFAULT;
        let mut segment_limit_po2 = SEGMENT_LIMIT_PO2_DEFAULT;
        let mut json_out: Option<PathBuf> = None;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--tape" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--tape requires a file path"))?;
                    tape_path = Some(PathBuf::from(value));
                }
                "--max-frames" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--max-frames requires a number"))?;
                    max_frames = value
                        .parse::<u32>()
                        .with_context(|| format!("invalid --max-frames value: {value}"))?;
                }
                "--segment-limit-po2" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--segment-limit-po2 requires a number"))?;
                    segment_limit_po2 = value
                        .parse::<u32>()
                        .with_context(|| format!("invalid --segment-limit-po2 value: {value}"))?;
                }
                "--json-out" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--json-out requires a file path"))?;
                    json_out = Some(PathBuf::from(value));
                }
                "-h" | "--help" => {
                    println!(
                        "Usage: cargo run --release -p host --bin benchmark -- --tape <file.tape> [--max-frames <n>] [--segment-limit-po2 <n>] [--json-out <file.json>]\n\nNote: This benchmark is intended to run in dev mode only (RISC0_DEV_MODE=1)."
                    );
                    process::exit(0);
                }
                other => return Err(anyhow!("unknown argument: {other}. Use --help for usage.")),
            }
        }

        let tape_path = tape_path.ok_or_else(|| anyhow!("--tape is required"))?;
        Ok(Self {
            tape_path,
            max_frames,
            segment_limit_po2,
            json_out,
        })
    }
}

/// Dev-mode benchmark entrypoint for measuring guest execution cycles.
///
/// This runs the guest executor (not prover), validates decoded journal output against
/// parsed tape expectations, and emits a cycle summary (and optional JSON).
fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse()?;
    if !host::risc0_dev_mode_enabled() {
        return Err(anyhow!(
            "RISC0_DEV_MODE is not enabled. This benchmark is dev-mode only. Re-run with: RISC0_DEV_MODE=1 cargo run -p host --release --no-default-features --bin benchmark -- ..."
        ));
    }

    let tape_bytes = fs::read(&cli.tape_path)
        .with_context(|| format!("failed to read tape: {}", cli.tape_path.display()))?;
    let (expected_seed, expected_frame_count, expected_score) = {
        let tape = parse_tape(&tape_bytes, cli.max_frames).context("failed to parse tape")?;
        (
            tape.header.seed,
            tape.header.frame_count,
            tape.footer.final_score,
        )
    };

    let tape_len = tape_bytes.len() as u32;
    let padded_tape = pad_to_word_boundary(tape_bytes);
    let benchmark_claimant = env::var("BENCHMARK_CLAIMANT")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".to_string());
    let benchmark_claimant = encode_claimant_for_journal(&benchmark_claimant).map_err(|err| {
        anyhow!("BENCHMARK_CLAIMANT must be a valid Stellar G... or C... address: {err}")
    })?;
    let seed_id = env::var("BENCHMARK_SEED_ID")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(0);

    let mut env_builder = ExecutorEnv::builder();
    env_builder.write_slice(&cli.max_frames.to_le_bytes());
    env_builder.write_slice(&seed_id.to_le_bytes());
    env_builder.write_slice(&benchmark_claimant);
    env_builder.write_slice(&tape_len.to_le_bytes());
    env_builder.write_slice(&padded_tape);
    env_builder.segment_limit_po2(cli.segment_limit_po2);
    let env = env_builder
        .build()
        .context("failed to build executor env")?;

    let session = default_executor()
        .execute(env, VERIFY_TAPE_ELF)
        .context("failed executing guest")?;
    let journal: VerificationJournal =
        decode_journal_raw(&session.journal.bytes).context("failed decoding journal")?;

    if journal.seed != expected_seed
        || journal.frame_count != expected_frame_count
        || journal.final_score != expected_score
    {
        return Err(anyhow!(
            "journal output mismatch: seed={:#x}/{:#x} frames={}/{} score={}/{}",
            journal.seed,
            expected_seed,
            journal.frame_count,
            expected_frame_count,
            journal.final_score,
            expected_score,
        ));
    }

    let total_cycles = session.cycles();
    let segments = session.segments.len() as u64;
    let cycles_per_frame = if journal.frame_count == 0 {
        0
    } else {
        total_cycles / journal.frame_count as u64
    };

    if let Some(path) = cli.json_out.as_ref() {
        let summary = BenchmarkJson {
            seed: journal.seed,
            seed_id: journal.seed_id,
            frame_count: journal.frame_count,
            final_score: journal.final_score,
            claimant: journal.claimant.clone(),
            segments,
            total_cycles,
            cycles_per_frame,
        };
        let json =
            serde_json::to_vec_pretty(&summary).context("failed serializing benchmark summary")?;
        fs::write(path, json)
            .with_context(|| format!("failed writing benchmark summary to {}", path.display()))?;
    }

    println!("Benchmark complete.");
    println!("  Seed:          0x{:08x}", journal.seed);
    println!("  Seed ID:       {}", journal.seed_id);
    println!("  Claimant:      {}", journal.claimant);
    println!("  Frames:        {}", journal.frame_count);
    println!("  Final score:   {}", journal.final_score);
    println!("  Segments:      {}", segments);
    println!("  Total cycles:  {}", total_cycles);
    println!("  Cycles/frame:  {}", cycles_per_frame);

    Ok(())
}
