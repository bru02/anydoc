# Vendored LiteParse crates

`liteparse` 2.17.0 and `liteparse-pdfium` 1.13.0 from crates.io (Apache-2.0,
https://github.com/run-llama/liteparse), wired in through `[patch.crates-io]`
in the workspace `Cargo.toml`. Only `anydoc-mobile` depends on them.

The first commit that added this directory holds the crates unchanged (minus
Cargo's registry bookkeeping files), so `git diff` against it shows exactly
what this fork changed.

## Upgrading

Replace both directories with the new crate sources, reapply the local
changes, and update the versions pinned in `native/Cargo.toml` and in the
LiteParse license notice in `scripts/build-native.mjs`. Delete this directory
and the patch entries once upstream ships the same behavior.
