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
  - `host.configure`: the POM hands over `gateway.openai_base_url`, `gateway.api_key`, and (when available) the common `workspace_root`. The library unpacks the replaceable runtime under the plugin directory and starts the launcher with that configuration. A new configuration restarts it; Harness state in `data/dsh-home/` and workspace data are kept separately from runtime replacement.
  - `ui.upstream`: tells the POM proxy the launcher's loopback port and per-launch token.
  - `ui/runtime.json`: the status the screen polls. It carries neither the port nor the token.
- `runtime/launcher.mjs` starts `dsh web` on loopback right away, whether or not the node serves a model yet. It keeps the POM route in the harness's home-level patch layer (`$DSH_HOME/cordis.patch.yml`, owned by the plugin and reloaded live by the harness) and polls `GET /v1/models` every 15 s, rewriting the route only when the list changes. The default model for new agents is a harness setting (`agent-default-model`, the value the model picker writes): the launcher points it at the first POM model only while it is still the composition default or names a POM model the node no longer serves, so a user's choice is kept. Reloading the `agent-default-model` entry itself takes the harness session controller down for good, which is why the default is never part of the patch. Providers the user adds on the harness Models page live in its settings document, which merges per provider over the patch layer. The launcher also selects the in-page workspace picker, registers the plugin working directory as a workspace, and serves only requests that carry the POM's token.
- `ui/` holds the plugin screen and the CSS scoper. The screen mounts the harness in `#dsh-root` and routes the harness portals (dialogs, menus, notices) into `#dsh-portals`, a zero-size fixed container. Both share the scoped styles and never push the POM layout. `ui/src/harness/pomContext.ts` keeps the client on the POM's light/dark theme and language: before boot it answers `matchMedia("(prefers-color-scheme: ...)")` from `<html data-theme>` and offers the POM locale in `navigator.languages`, then follows the `theme.changed` and `locale.changed` events of the POM's `pom-plugin-events/v1` protocol (the `pom:plugin-event` DOM channel), falling back to watching `data-theme` on a POM without that protocol.
- `scripts/fetch-runtime.sh` packs a portable Node.js with its npm and the launcher as the archive the library embeds (about 50 MB on Linux). The official `@deepseek-ai/dsh` release is not bundled: `runtime/dsh-install.mjs` installs it from npm into `data/dsh/<version>` on first use and, on every start, moves to the newest version of the npm dist-tag given by `--dsh-version` (default `latest`, recorded as `dsh_track` in `runtime.json`), deleting the previous one. An offline start keeps the installed version; the very first start needs the npm registry and can take a few minutes.
- `docs/using-the-harness.md` describes the admin experience; `docs/plugin-contract.md` documents the POM host contract and persistence boundary. The menu image is `ui/icon.png`, the DeepSeek whale from the official `@deepseek-ai/dsh-web-frontend` favicon (MIT), declared as the manifest-level `icon_image`; `terminal` remains its fallback.

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

- **Bundle rewriting depends on current harness internals.** The rewrites cover `location.origin`, `#root`, the HMR event source, and the loopback check that decides whether the harness keeps its settings on the host (a POM-mounted page counts as loopback, since the node's admin-only proxy is the harness's only client). The harness is a developer preview, and the plugin now follows its newest release on npm by itself, so a new harness release can require adjusting them without a plugin build having changed. Pin an exact version with `--dsh-version` when that happens.
- **Portals are recognized by their class names.** A harness node appended to `<body>` goes to `#dsh-portals` when it uses a class from the harness's CSS Modules stylesheets. A portal without such a class would render outside the scoped styles.
- **The harness runs as the POM user.** It uses that user's home directory, including any agent skills found there, and the POM API key it receives is the node's chat key.
- **Theme and language follow the POM while the harness setting is "System".** A light or dark theme picked explicitly in the harness settings wins over the POM, as in the stand-alone client. The harness ships English and Chinese only, so the POM's Portuguese shows the harness in English.
