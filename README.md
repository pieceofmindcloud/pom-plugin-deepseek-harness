# POM Plugin - DeepSeek Harness

Runs the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) inside the POM admin UI, as the **Deepseek Harness** menu item and route (`/admin-ui/deepseek_harness/harness`), already connected to the models the POM node serves.

This repository holds no harness code. Every build installs the official prebuilt `@deepseek-ai/dsh` release from npm (default dist-tag `latest`) and wraps it as a POM plugin.

> Test implementation. See [Known limitations](#known-limitations) before using it outside a trusted machine.

## How it works

```text
POM admin UI (/admin-ui/deepseek_harness/harness)
  └─ plugin screen (ui/) ── mounts the harness web client into <div id="dsh-root">
        │  CSS scoped to #dsh-root, requests carry the per-launch key
        ▼
  launcher proxy  http://<pom host>:<port>        (runtime/launcher.mjs)
        │  rewrites the harness bundles' origin and #root, holds the harness session
        ▼
  dsh web  127.0.0.1:<port>   (official @deepseek-ai/dsh, unmodified)
        │  pi-ai provider "pom" + default agent model
        ▼
  POM OpenAI-compatible endpoint  (DSH_POM_LLM_BASE_URL, default http://127.0.0.1:8080/v1)
```

- `src/` - the `cdylib` the POM loads (`pom_deepseek_harness_plugin_v1`). It embeds the UI and the runtime archive, unpacks the runtime once per checksum under the plugin data directory, starts the launcher, and serves its status as the dynamic `ui/runtime.json` asset.
- `runtime/launcher.mjs` - starts `dsh web` on loopback with a loader overlay. The overlay registers the POM models (from `GET /v1/models`), makes the first one the default, and selects the in-page workspace picker. The launcher also registers the plugin working directory as a workspace and fronts everything with the proxy.
- `ui/` - the plugin screen and the CSS scoper. `scripts/fetch-runtime.sh` - portable Node.js plus `npm install @deepseek-ai/dsh@<tag>`, packed as the archive the library embeds.

## Configuration

Environment variables seen by the POM node process, which the plugin host inherits:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_POM_LLM_BASE_URL` | `http://127.0.0.1:8080/v1` | POM OpenAI-compatible endpoint |
| `DSH_POM_LLM_API_KEY` | none | Bearer key for that endpoint, if it needs one |
| `DSH_POM_PROXY_HOST` | `127.0.0.1` | Proxy bind address; `0.0.0.0` lets browsers on other machines reach it |
| `DSH_POM_PROXY_PORT` | random | Fixed proxy port |
| `DSH_POM_WORKSPACE` | `<data>/workspace` | Directory registered as the default workspace |

## Build and verify

Requirements: Rust stable, Node.js 22.19+ or 24, npm, curl.

```sh
cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
node --test tests/unit/*.test.mjs
scripts/package.sh --platform macos-aarch64 --version 0.1.0 [--dsh-version latest|next|<version>]
```

Build on the target platform: the npm install resolves native dependencies (`node-pty`, `sharp`) for the machine it runs on. The packaged library is about 86 MB, and the unpacked runtime about 410 MB.

## Releases

`.github/workflows/publish-release.yml` is the manual release flow from `pom-plugin-base`, plus a `dsh_version` input: each selected platform installs that harness release from npm, builds, and publishes to GitHub and optionally to the license server. `ci.yml` runs the checks on every push and pull request.

## End-to-end test

`tests/e2e/pom-stub.mjs` serves a real POM admin UI build (from the `pom` repository, branch `feat/enterprise`, `apps/frontend`) and implements the plugin UI contract with the real `pom-plugin-host` loading the packaged library. `tests/e2e/mock-pom-llm.mjs` stands in for the POM model endpoint.

```sh
MOCK_LLM_PORT=18431 node tests/e2e/mock-pom-llm.mjs &
POM_FRONTEND_DIST=<pom>/apps/frontend/dist POM_PLUGIN_HOST=<pom>/target/release/pom-plugin-host \
POM_PLUGIN_LIBRARY=$PWD/dist-release/pom-plugin-deepseek-harness-macos-aarch64.dylib \
DSH_POM_LLM_BASE_URL=http://127.0.0.1:18431/v1 node tests/e2e/pom-stub.mjs
# open http://127.0.0.1:18480/admin-ui/deepseek_harness/harness
```

## Known limitations

- **Portals and modals are not adapted yet.** Harness dialogs, menus and notices render as children of `<body>`, outside `#dsh-root`, so they appear unstyled at the bottom of the page. Examples: the first-run notice, the workspace picker, the model menu and Settings.
- **The proxy is not behind POM authentication.** Its key is published through `ui/runtime.json`, and the POM asset route is not admin-only. Anyone who can read that asset can drive the harness, which runs shell commands on the node. The proxy therefore binds to loopback by default. The robust design is an admin-only reverse-proxy route in the POM node itself (`/api/ui/plugins/:code/proxy/*`).
- **Plain HTTP on a separate port.** A POM served over HTTPS would block it as mixed content.
- **Bundle rewriting depends on current harness internals.** The rewrites cover `location.origin`, `#root` and the HMR event source. The harness is a developer preview, so a new release can require adjusting them.
- **The harness theme follows its own setting**, not the POM theme.
