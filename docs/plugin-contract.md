# POM plugin contract

This plugin implements `pom-plugin-ui/v1` and the generic plugin ABI. The authoritative declaration is `ui/manifest.json`; the runtime behavior is in `src/lib.rs` and `src/supervisor.rs`.

## Host integration

- The host calls `host.configure` with `gateway.openai_base_url` and `gateway.api_key`. It may also provide the common `workspace_root` path. When omitted, the plugin uses its managed workspace directory.
- `ui.upstream` returns only the loopback port and per-launch proxy token once ready. `ui/runtime.json` exposes status without that token.
- Runtime assets are returned through `ui.asset`; the PNG icon is optional and the menu's `terminal` icon is the fallback for hosts that do not render `icon_image`.
- The POM node must provide its admin-only plugin proxy and strip POM credentials before proxying to the plugin.

## Persistent data and upgrades

The plugin-managed runtime bundle is installed under `runtime/` and may be replaced when its archive checksum changes. Harness state lives separately in `data/dsh-home/`; the workspace and launcher-owned configuration also live under `data/`. Runtime replacement must never prune or overwrite `dsh-home`, user workspace contents, or persistent Harness settings. The Rust unit test `runtime_unpacks_once_per_checksum_and_replaces_older_ones` guards the data-preservation boundary.

## Build and checks

See the root README for build requirements and the E2E recipe. Run `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `node --test tests/unit/*.test.mjs` for local validation.
