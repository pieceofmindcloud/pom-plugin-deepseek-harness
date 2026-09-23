# POM Plugin - DeepSeek Harness

Runs the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) inside the POM admin UI, as the **Deepseek Harness** menu item and route (`/admin-ui/deepseek_harness/harness`), already connected to the models the POM node serves.

This repository holds no harness code. Every build installs the official prebuilt `@deepseek-ai/dsh` release from npm (default dist-tag `latest`) and wraps it as a POM plugin.

> Test implementation. See [Known limitations](#known-limitations).

## How it works

```text
POM admin UI (/admin-ui/deepseek_harness/harness)
  └─ plugin screen (ui/) ── mounts the harness web client into <div id="dsh-root">
        │  CSS scoped to #dsh-root; same-origin requests, POM session
        ▼
  POM node  /api/ui/plugins/deepseek_harness/proxy/*   (admin-only plugin proxy)
        │  adds x-pom-plugin-token and x-forwarded-prefix, strips POM credentials
        ▼
  launcher proxy  127.0.0.1:<port>          (runtime/launcher.mjs)
        │  rewrites the harness bundles' origin and #root, holds the harness session
        ▼
  dsh web  127.0.0.1:<port>   (official @deepseek-ai/dsh, unmodified)
        │  pi-ai provider "pom" + default agent model
        ▼
  POM OpenAI-compatible endpoint  (handed over by the POM in host.configure)
```

- `src/` is the `cdylib` the POM loads (`pom_deepseek_harness_plugin_v1`). It embeds the UI and the runtime archive, and answers three `query` operations besides `ui.manifest` and `ui.asset`:
  - `host.configure`: the POM hands over `gateway.openai_base_url` and `gateway.api_key`. The library then unpacks the runtime once per checksum under the plugin data directory and starts the launcher with those values. A new configuration restarts it.
  - `ui.upstream`: tells the POM proxy the launcher's loopback port and per-launch token.
  - `ui/runtime.json`: the status the screen polls. It carries neither the port nor the token.
- `runtime/launcher.mjs` starts `dsh web` on loopback right away, whether or not the node serves a model yet. It keeps the POM route in the harness's home-level patch layer (`$DSH_HOME/cordis.patch.yml`, owned by the plugin and reloaded live by the harness) and polls `GET /v1/models` every 15 s. When the list changes, the route's models and the default agent model follow it, with no restart. Providers the user adds on the harness Models page live in its settings document, which merges per provider over this layer. The launcher also selects the in-page workspace picker, registers the plugin working directory as a workspace, and serves only requests that carry the POM's token.
- `ui/` holds the plugin screen and the CSS scoper. The screen mounts the harness in `#dsh-root` and routes the harness portals (dialogs, menus, notices) into `#dsh-portals`, a zero-size fixed container. Both share the scoped styles and never push the POM layout.
- `scripts/fetch-runtime.sh` installs a portable Node.js plus `@deepseek-ai/dsh@<tag>` from npm, packed as the archive the library embeds.

The model endpoint and key never come from the build or from environment variables: the POM provides them. It requires a POM with the plugin proxy and `host.configure` (branch `feat/plugin-ui-proxy` of the `pom` repository).

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

`tests/e2e/pom-stub.mjs` serves a real POM admin UI build (from the `pom` repository, `apps/frontend`) and mirrors the node's plugin contract: the UI assets, `host.configure`, and the `/api/ui/plugins/:code/proxy/*` route. It uses the real `pom-plugin-host` loading the packaged library. `tests/e2e/mock-pom-llm.mjs` stands in for the POM model endpoint and, with `MOCK_LLM_API_KEY`, rejects any request without that key.

```sh
MOCK_LLM_PORT=18431 MOCK_LLM_API_KEY=sk-e2e node tests/e2e/mock-pom-llm.mjs &
POM_FRONTEND_DIST=<pom>/apps/frontend/dist POM_PLUGIN_HOST=<pom>/target/release/pom-plugin-host \
POM_PLUGIN_LIBRARY=$PWD/dist-release/pom-plugin-deepseek-harness-macos-aarch64.dylib \
POM_STUB_LLM_BASE_URL=http://127.0.0.1:18431/v1 POM_STUB_API_KEY=sk-e2e node tests/e2e/pom-stub.mjs
# open http://127.0.0.1:18480/admin-ui/deepseek_harness/harness
```

The node side of the contract is tested in the `pom` repository (`plugin_proxy` and `plugins::tests::host_context_and_ui_proxy_reach_a_real_plugin_host`).

## Known limitations

- **Bundle rewriting depends on current harness internals.** The rewrites cover `location.origin`, `#root` and the HMR event source. The harness is a developer preview, so a new release can require adjusting them.
- **Portals are recognized by their class names.** A harness node appended to `<body>` goes to `#dsh-portals` when it uses a class from the harness's CSS Modules stylesheets. A portal without such a class would render outside the scoped styles.
- **The harness runs as the POM user.** It uses that user's home directory, including any agent skills found there, and the POM API key it receives is the node's chat key.
- **The harness theme follows its own setting**, not the POM theme.
