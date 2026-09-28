# Project agent memory

- This plugin is a shell around the official `@deepseek-ai/dsh` npm release; never vendor harness source. `README.md` has the architecture, configuration and known limitations.
- The POM owns the model endpoint, the API key (`host.configure`) and browser access (its admin-only `/api/ui/plugins/:code/proxy/*` route, reached through `ui.upstream`); the node side lives in the `pom` repository (`crates/node/src/plugin_proxy.rs`, `plugins.rs`). Never add an env var or build input for them here.
- Browser-side adaptation lives in two places that must stay in sync: bundle rewrites in `runtime/launcher.mjs` (`rewriteScript`, `bootPlan`) and the runtime bridges in `ui/src/harness/mount.ts` (`__DSH_POM__` placeholder origin mapped to the proxy prefix, relative `api/` URLs, CSS scoping). Theme and language follow the POM through `ui/src/harness/pomContext.ts` (`matchMedia`/`navigator.languages` answered from the POM, updated by `pom-plugin-events/v1`).
- The plugin host uses its own stdin/stdout for IPC: processes the library starts must never inherit them (`src/supervisor.rs`).
- `scripts/build.sh` runs `scripts/fetch-runtime.sh` and passes `DSH_RUNTIME_ARCHIVE` to cargo; without it the library builds but reports that no runtime is bundled.
- Checks: `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `node --test tests/unit/*.test.mjs` (Node 22 needs `--experimental-strip-types`). The end-to-end recipe is in `README.md`. When `cargo` resolves to a wrapper, use `~/.cargo/bin/cargo`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project. Do not repeat what the codebase already shows; point to the authoritative file or command instead. Prefer rewriting or pruning existing entries over appending new ones. When updating this file, preserve this bar for all agents and keep entries concise.
