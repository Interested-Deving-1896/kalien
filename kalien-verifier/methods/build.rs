use std::{env, path::Path};

fn running_under_clippy() -> bool {
    env::var_os("RUSTC_WORKSPACE_WRAPPER")
        .and_then(|wrapper| Path::new(&wrapper).file_name().map(|name| name.to_owned()))
        .is_some_and(|name| name == "clippy-driver")
}

fn main() {
    // Clippy wraps workspace rustc invocations with `clippy-driver`, but the RISC0 guest
    // toolchain target is not available through that path. `risc0-build` already supports
    // skipping guest rebuilds via `RISC0_SKIP_BUILD`, which still emits the embed artifacts
    // needed for host-side linting.
    if running_under_clippy() && env::var_os("RISC0_SKIP_BUILD").is_none() {
        env::set_var("RISC0_SKIP_BUILD", "1");
    }

    risc0_build::embed_methods();
}
