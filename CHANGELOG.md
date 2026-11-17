# @agentsautonomous.ai/mastra-agent37

## Unreleased

### Internal

- Unit tests run on macOS: the test harness uses Homebrew's GNU coreutils, findutils, and util-linux for the instance scripts, and skips those suites with a warning that names the missing tools (or fails them under CI). CI adds a `macos-latest` job for lint, typecheck, and unit tests. No change to the published package.

## 0.1.0

### Minor Changes

- Initial release of the community Agent37 Cloud sandbox provider for Mastra workspaces, by Agents Autonomous.
  - `Agent37Sandbox` with get-or-create by logical id (instance metadata), adoption by instance id, `sleep` or `stop` on stop, delete on destroy, and reconnect-or-recreate when an instance disappears.
  - Process manager with streamed output, timeouts, abort signals, background processes, stdin, and process-group kill, built on Agent37 exec.
  - `Agent37Filesystem`: a Mastra `WorkspaceFilesystem` over exec with chunked transfers and typed errors.
  - Computer use on `agent37-ubuntu` (XFCE) through Mastra's `SandboxComputer`: screenshots, mouse, keyboard, and a signed noVNC stream URL.
  - `networking.getPortUrl()` with public ports or signed URLs.
  - `Agent37Client`, a typed client for the Agent37 Cloud REST API with retries on transient errors.
