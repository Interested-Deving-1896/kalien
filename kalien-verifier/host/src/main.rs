use std::{env, fs, path::PathBuf, str::FromStr};

use anyhow::{anyhow, Context, Result};
use asteroids_verifier_core::normalize_claimant_strkey;
use host::{
    prove_tape, ProofMode, ProveOptions, ReceiptKind, VerifyMode, SEGMENT_LIMIT_PO2_DEFAULT,
};

#[derive(Debug)]
struct Cli {
    tape_path: PathBuf,
    max_frames: u32,
    seed_id: u32,
    claimant: String,
    journal_out: Option<PathBuf>,
    segment_limit_po2: u32,
    receipt_kind: ReceiptKind,
    proof_mode: ProofMode,
    verify_mode: VerifyMode,
}

impl Cli {
    /// Parse CLI arguments into strongly typed proving options.
    ///
    /// Required:
    /// - `--tape <path>`
    /// - `--claimant <G...|C...>`
    ///
    /// Optional flags control seed ID, frame cap, receipt mode, and output paths.
    fn parse() -> Result<Self> {
        let mut args = env::args().skip(1);

        let mut tape_path: Option<PathBuf> = None;
        let mut max_frames = 36_000u32;
        let mut seed_id = 0u32;
        let mut claimant: Option<String> = None;
        let mut journal_out: Option<PathBuf> = None;
        let mut segment_limit_po2 = SEGMENT_LIMIT_PO2_DEFAULT;
        let mut receipt_kind = ReceiptKind::Composite;
        let mut proof_mode = ProofMode::Secure;
        let mut verify_mode = VerifyMode::Verify;

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
                "--seed-id" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--seed-id requires a number"))?;
                    seed_id = value
                        .parse::<u32>()
                        .with_context(|| format!("invalid --seed-id value: {value}"))?;
                }
                "--claimant" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--claimant requires a Stellar address"))?;
                    claimant = Some(value.trim().to_string());
                }
                "--journal-out" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--journal-out requires a file path"))?;
                    journal_out = Some(PathBuf::from(value));
                }
                "--segment-limit-po2" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--segment-limit-po2 requires a number"))?;
                    segment_limit_po2 = value
                        .parse::<u32>()
                        .with_context(|| format!("invalid --segment-limit-po2 value: {value}"))?;
                }
                "--receipt-kind" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--receipt-kind requires a value"))?;
                    receipt_kind = ReceiptKind::from_str(&value)?;
                }
                "--proof-mode" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--proof-mode requires a value"))?;
                    proof_mode = ProofMode::from_str(&value)?;
                }
                "--verify-mode" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--verify-mode requires a value"))?;
                    verify_mode = VerifyMode::from_str(&value)?;
                }
                "-h" | "--help" => {
                    println!(
                        "Usage: cargo run --release -- --tape <file.tape> --claimant <G...|C...> [--seed-id <u32>] [--max-frames <n>] [--journal-out <file.json>] [--segment-limit-po2 <n>] [--receipt-kind composite|succinct|groth16] [--proof-mode secure|dev] [--verify-mode verify|policy]\nDefault --segment-limit-po2: {SEGMENT_LIMIT_PO2_DEFAULT}"
                    );
                    std::process::exit(0);
                }
                other => return Err(anyhow!("unknown argument: {other}. Use --help for usage.")),
            }
        }

        let tape_path = tape_path.ok_or_else(|| anyhow!("--tape is required"))?;

        let claimant = claimant.ok_or_else(|| anyhow!("--claimant is required"))?;
        let claimant = normalize_claimant_strkey(&claimant).map_err(|err| {
            anyhow!("--claimant must be a valid Stellar G... or C... address: {err}")
        })?;

        Ok(Self {
            tape_path,
            max_frames,
            seed_id,
            claimant,
            journal_out,
            segment_limit_po2,
            receipt_kind,
            proof_mode,
            verify_mode,
        })
    }
}

/// Host CLI entrypoint.
///
/// Reads a tape from disk, runs proof generation, optionally writes journal JSON,
/// and prints a concise proof/journal summary.
fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse()?;
    let tape = fs::read(&cli.tape_path)
        .with_context(|| format!("failed to read tape: {}", cli.tape_path.display()))?;

    let proof = prove_tape(
        tape,
        ProveOptions {
            max_frames: cli.max_frames,
            seed_id: cli.seed_id,
            claimant: cli.claimant.clone(),
            segment_limit_po2: cli.segment_limit_po2,
            receipt_kind: cli.receipt_kind,
            proof_mode: cli.proof_mode,
            verify_mode: cli.verify_mode,
        },
    )?;

    println!("Verification proof generated and validated.");
    println!(
        "  Receipt kind:  {}",
        proof
            .produced_receipt_kind
            .map(|kind| kind.as_str())
            .unwrap_or("dev-fake")
    );
    println!("  Seed:          0x{:08x}", proof.journal.seed);
    println!("  Seed ID:       {}", proof.journal.seed_id);
    println!("  Claimant:      {}", proof.journal.claimant);
    println!("  Frames:        {}", proof.journal.frame_count);
    println!("  Final score:   {}", proof.journal.final_score);
    println!("  Segments:      {}", proof.stats.segments);
    println!("  Total cycles:  {}", proof.stats.total_cycles);
    println!("  User cycles:   {}", proof.stats.user_cycles);
    println!("  Paging cycles: {}", proof.stats.paging_cycles);
    println!("  Reserved:      {}", proof.stats.reserved_cycles);

    if let Some(path) = cli.journal_out {
        let json = serde_json::to_vec_pretty(&proof.journal)
            .context("failed to serialize journal json")?;
        fs::write(&path, json)
            .with_context(|| format!("failed writing journal output: {}", path.display()))?;
        println!("  Journal JSON:  {}", path.display());
    }

    Ok(())
}
