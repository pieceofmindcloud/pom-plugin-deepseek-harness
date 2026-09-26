# Using DeepSeek Harness in POM

The **Deepseek Harness** screen is available to POM administrators. It opens the official DeepSeek Harness web client inside the POM; no separate browser login is needed.

## Workspaces

The plugin uses the `workspace_root` supplied by the POM during `host.configure`. The selected directory is registered as a Harness workspace and is the working directory for new sessions. If the host does not provide `workspace_root`, the plugin uses its own `data/workspace` directory.

Files created in a workspace remain there independently of plugin upgrades. Harness settings and session data are stored in the plugin's persistent `data/dsh-home` directory and are not part of the replaceable runtime bundle.

## Models

Models served by the POM node are available through the POM provider. The plugin refreshes the model list periodically. The default model is selected automatically for a new installation; an administrator's explicit model selection is retained unless that model is no longer available.

The POM supplies the endpoint and API key through the plugin host. They are not build-time settings. Treat the POM user's API key as a credential and do not share access to this administrator-only screen with untrusted users.

## Troubleshooting

- If the screen reports that it is starting, verify that the POM supports `host.configure` and the admin-only plugin UI proxy.
- If no models appear, check that the node serves models and that its OpenAI-compatible endpoint is reachable by the plugin host.
- Workspace access follows the filesystem permissions of the POM process.
