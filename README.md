# @mastra/agent37

[Agent37 Cloud](https://www.agent37.com) sandbox provider for [Mastra](https://mastra.ai) workspaces.

Give a Mastra agent its own Linux machine on Agent37: shell commands with streamed output, background processes with stdin, a full filesystem, public URLs for ports, and computer use (screenshot, mouse, keyboard) on a real XFCE desktop. Instances sleep when idle and are found again by id, so an agent's workspace survives restarts and process boundaries.

```ts
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { Agent37Sandbox } from '@mastra/agent37';

const sandbox = new Agent37Sandbox({ id: 'my-project' });
const agent = new Agent({
  id: 'coder',
  name: 'Coder',
  instructions: 'You are a careful software engineer.',
  model: 'anthropic/claude-sonnet-4-5',
  workspace: new Workspace({ sandbox, filesystem: sandbox.filesystem }),
});
```

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Lifecycle and persistence](#lifecycle-and-persistence)
- [Commands and processes](#commands-and-processes)
- [Filesystem](#filesystem)
- [Ports and URLs](#ports-and-urls)
- [Computer use](#computer-use)
- [Running agents inside Agent37](#running-agents-inside-agent37)
- [Cost](#cost)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)
- [Development](#development)

## Installation

```bash
npm install @mastra/agent37 @mastra/core
# or
pnpm add @mastra/agent37 @mastra/core
```

Requires Node.js 22.13 or later and `@mastra/core` 1.83 or later.

Create a workspace API key in the Agent37 dashboard under **Cloud → API keys** and expose it as `AGENT37_API_KEY`:

```bash
export AGENT37_API_KEY=sk_live_...
```

The provider reads the key from the environment by default; pass `apiKey` to override it.

## Quick start

### Commands and files through a workspace

```ts
import { Workspace } from '@mastra/core/workspace';
import { Agent37Sandbox } from '@mastra/agent37';

const sandbox = new Agent37Sandbox({ id: 'quick-start' });
const workspace = new Workspace({ sandbox, filesystem: sandbox.filesystem });

await workspace.init(); // finds the instance tagged 'quick-start', or creates it

const result = await sandbox.executeCommand('python3', ['-c', 'print(6 * 7)']);
console.log(result.stdout); // "42\n"

await sandbox.filesystem.writeFile('/home/node/notes.md', '# Notes\n');
console.log(await sandbox.filesystem.readdir('/home/node'));

await workspace.destroy(); // deletes the instance
```

Passing `sandbox.filesystem` as the workspace filesystem gives the agent Mastra's file tools (read, write, edit, list, grep) on the instance disk. The sandbox alone gives it command and process tools.

### An agent with a desktop

```ts
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { Agent37Sandbox } from '@mastra/agent37';

const sandbox = new Agent37Sandbox({ computer: true }); // agent37-ubuntu VM with XFCE and Firefox
const workspace = new Workspace({ sandbox });

const agent = new Agent({
  id: 'desktop-agent',
  name: 'Desktop Agent',
  instructions: 'You operate a Linux desktop. Take a screenshot before acting and after each step.',
  model: 'anthropic/claude-sonnet-4-5',
  workspace,
});

await workspace.init();
console.log('Watch live:', await sandbox.computer!.streamUrl());
const answer = await agent.generate('Open Firefox and tell me the title of mastra.ai', { maxSteps: 40 });
console.log(answer.text);
await workspace.destroy();
```

With `computer` set, the workspace registers Mastra's computer tools (`mastra_workspace_computer_screenshot`, `_click`, `_double_click`, `_type`, `_press_key`, `_scroll`, `_drag`, and the rest). See [Computer use](#computer-use).

## Configuration

Every option is optional.

### Instance

| Option               | Type                                               | Default                                                             | Description                                                                                                                                 |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`                                           | random                                                              | Logical sandbox id. Stored in the instance metadata (`mastra_sandbox_id`) so any process using the same id reconnects to the same instance. |
| `instanceId`         | `string`                                           |                                                                     | Adopt an existing Agent37 instance by its 10-character id instead of looking it up by `id`.                                                 |
| `template`           | `string`                                           | `agent37-ubuntu` with `computer`, else `agent37-base`               | Template to create from. Pin a release with `name@version`.                                                                                 |
| `type`               | `'default' \| 'vm' \| 'performance'`               | `vm` for `agent37-ubuntu`/`agent37-android`, else Agent37's default | Instance type.                                                                                                                              |
| `region`             | `'us' \| 'eu' \| 'ap-south'`                       | Agent37's default (`us`)                                            | Region.                                                                                                                                     |
| `resources`          | `{ cpu, memory, disk }`                            | template default                                                    | Shape; memory and disk in GB.                                                                                                               |
| `instanceName`       | `string`                                           | `mastra-<id>` (60 chars max)                                        | Label in the Agent37 dashboard.                                                                                                             |
| `metadata`           | `Record<string, string>`                           |                                                                     | Extra instance metadata. The provider adds `mastra_sandbox_id` and `mastra_provider`.                                                       |
| `instanceEnv`        | `Record<string, string>`                           |                                                                     | Container environment variables, set at create and replayed on every boot.                                                                  |
| `autoSleep`          | `boolean`                                          | `true`                                                              | Let Agent37 checkpoint the instance to `sleeping` (disk-only billing) when idle.                                                            |
| `idleTimeoutSeconds` | `number`                                           | `900`                                                               | Idle seconds before auto-sleep, 300 to 86400.                                                                                               |
| `network`            | `'allow-all' \| 'deny-all' \| { allow: string[] }` | Agent37's default (`allow-all`)                                     | Outbound network policy.                                                                                                                    |
| `createParams`       | `Partial<Agent37CreateInstanceParams>`             |                                                                     | Any other create fields (`budget`, `public_ports`, `mount_path`, ...), merged last.                                                         |
| `stopMode`           | `'sleep' \| 'stop'`                                | `'sleep'`                                                           | What stopping does. See [Lifecycle](#lifecycle-and-persistence).                                                                            |

### Commands

| Option             | Type                                             | Default                                        | Description                                                                                                     |
| ------------------ | ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `env`              | `Record<string, string>`                         |                                                | Environment for every command. Sent per command, never written to the instance. Update with `sandbox.setEnv()`. |
| `workingDirectory` | `string`                                         | image default (`/home/node` on `agent37-base`) | Default working directory.                                                                                      |
| `user`             | `'root'`                                         | image default user                             | Run commands as root.                                                                                           |
| `timeout`          | `number`                                         | `300000` (5 min)                               | Default `executeCommand` timeout in ms.                                                                         |
| `processes`        | `{ quickWaitMs, pollWindowMs, stdinChunkBytes }` | `1000`, `5000`, `256 KiB`                      | Output collection tuning. See [Commands and processes](#commands-and-processes).                                |

### Computer, URLs, and connection

| Option              | Type                                | Default                       | Description                                                                           |
| ------------------- | ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `computer`          | `boolean \| Agent37ComputerOptions` | `false`                       | Enable computer use. See [Computer use](#computer-use) for the sub-options.           |
| `portUrlTtlSeconds` | `number`                            | `3600`                        | Lifetime of the signed URLs `networking.getPortUrl()` mints.                          |
| `apiKey`            | `string`                            | `process.env.AGENT37_API_KEY` | Workspace API key.                                                                    |
| `apiUrl`            | `string`                            | `https://api.agent37.com/v1`  | Sandbox API base URL.                                                                 |
| `execUrl`           | `string`                            | `https://sandbox.agent37.app` | Exec base URL.                                                                        |
| `fetch`             | `typeof fetch`                      | global `fetch`                | Custom fetch (proxies, tests).                                                        |
| `client`            | `Agent37Client`                     |                               | A shared, preconfigured client. Overrides `apiKey`, `apiUrl`, `execUrl`, and `fetch`. |

Mastra's own sandbox options (`onStart`, `onStop`, `onDestroy`) are supported too.

## Lifecycle and persistence

The sandbox follows Mastra's get-or-create contract. Starting it looks for an instance in this order, and creates one only when none is found:

1. the `instanceId` option, or the instance from an earlier start;
2. an instance whose metadata carries this sandbox's `id`.

A sleeping or stopped instance is woken; one in a failed state is deleted and replaced. So `new Agent37Sandbox({ id: 'user-42' })` in a new process, on another server, or a week later reconnects to the same machine with the same files.

Workspaces drive the lifecycle for you (`workspace.init()`, `workspace.destroy()`). On a bare sandbox, call Mastra's lifecycle wrappers, which track `status` and guard against concurrent calls:

| Call                 | Effect                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox._start()`   | Find or create the instance and wait until it runs. Commands and file calls also start the sandbox on demand.                                                                   |
| `sandbox._stop()`    | With `stopMode: 'sleep'` (default): checkpoint memory and processes to disk. With `'stop'`: halt the container; files survive, processes and memory don't. Both bill disk only. |
| `sandbox._destroy()` | Delete the instance and its disk.                                                                                                                                               |

`_destroy()` does nothing on a sandbox object that was never started, as Mastra defines it. To delete an instance by id from a fresh process, call the provider method directly: `await new Agent37Sandbox({ id }).destroy()`.

|                         | `stopMode: 'sleep'`    | `stopMode: 'stop'` |
| ----------------------- | ---------------------- | ------------------ |
| Files                   | kept                   | kept               |
| Background processes    | resume where they were | killed             |
| Restart time (measured) | about 1.1 s            | about 1.5 s        |
| Billing while stopped   | disk only              | disk only          |

With `autoSleep` (default on), Agent37 also sleeps an idle instance after `idleTimeoutSeconds`, and the next command wakes it transparently.

If an instance disappears or halts under a running sandbox (deleted in the dashboard, stopped elsewhere), the next command reconnects or recreates it once and retries.

## Commands and processes

```ts
const result = await sandbox.executeCommand('npm', ['test'], {
  cwd: '/home/node/app',
  env: { CI: '1' },
  timeout: 120_000,
  onStdout: chunk => process.stdout.write(chunk),
  onStderr: chunk => process.stderr.write(chunk),
});
result.exitCode; // 0
result.timedOut; // false
```

Background processes:

```ts
const server = await sandbox.processes.spawn('node server.js', { cwd: '/home/node/app' });
const repl = await sandbox.processes.spawn('python3 -i -q');
await repl.sendStdin('print(6 * 7)\n');
await repl.closeStdin();
console.log((await repl.wait()).stdout);

await sandbox.processes.list(); // [{ pid, command, running, exitCode }]
await server.kill(); // SIGTERM to the whole process group, SIGKILL after 2 s
```

How it works: Agent37's exec API runs a script and returns its output when it ends. To get streaming, stdin, and background processes on top of that, each process runs under a small runner in its own session (`setsid`) that records output and exit status under `/tmp/.mastra-agent37/proc/`. The provider long-polls those files (`processes.pollWindowMs`, 5 s by default) and delivers output as it arrives, so expect output in bursts rather than byte by byte. Stdin goes through a FIFO, and `kill()` signals the whole process group, children included.

Output is retained up to Mastra's default per-stream cap (1 MiB); pass `maxRetainedBytes` to change it. A single exec can carry a script of up to about 1 MB.

`sandbox.runScript(script, { user: 'root' })` runs one raw exec and returns `{ exit_code, stdout, stderr }`, as an escape hatch.

## Filesystem

`sandbox.filesystem` is an `Agent37Filesystem` (a Mastra `WorkspaceFilesystem`) for the instance disk:

```ts
const fs = sandbox.filesystem;
await fs.writeFile('/home/node/app/data.bin', buffer); // parents created by default
await fs.readFile('/home/node/app/data.bin'); // Buffer
await fs.readFile('/home/node/app/README.md', { encoding: 'utf-8' });
await fs.appendFile('/home/node/app/log.txt', 'line\n');
await fs.readdir('/home/node/app', { recursive: true, extension: '.ts' });
await fs.stat('/home/node/app/package.json');
await fs.copyFile('/a', '/b', { recursive: true, overwrite: false });
await fs.moveFile('/a', '/b');
await fs.mkdir('/home/node/x/y');
await fs.rmdir('/home/node/x', { recursive: true });
await fs.chmod('/home/node/run.sh', 0o755);
```

Errors are Mastra's typed errors (`FileNotFoundError`, `IsDirectoryError`, `FileExistsError`, `DirectoryNotEmptyError`, ...). Writes go to a temp file and are moved into place; overwriting an existing file keeps its mode.

Agent37 only offers a files API on agent templates, so this filesystem runs over exec on every template: file bytes travel base64-encoded, 360 KB per read call and 512 KB per write call. In our live runs a 1.5 MB file took 2 to 3 seconds each way. For bulk transfers (a whole repository), prefer `git clone` or `curl` inside the instance.

Paths are absolute (relative paths resolve from `/`). The persistent disk is the instance `mount_path` (`/home/node` on `agent37-base`); keep data you need across restarts there.

## Ports and URLs

```ts
await sandbox.processes.spawn('python3 -m http.server 8080');
const url = await sandbox.networking.getPortUrl(8080); // signed, browser-openable, 1 hour
```

`getPortUrl` returns the public URL for ports listed in `createParams.public_ports`, and otherwise mints a signed URL that expires after `portUrlTtlSeconds`. Anyone holding a signed URL can reach the port until it expires. `sandbox.signedUrl(port, ttl)` mints one with a custom lifetime, and `sandbox.previewUrl(port)` returns the authenticated URL (requests need the `X-Agent37-Key` header).

## Computer use

```ts
const sandbox = new Agent37Sandbox({
  computer: {
    display: ':1', // default: first display that accepts connections
    autoInstall: true, // install xdotool and scrot with apt on first use
    streamPort: 6080, // noVNC port for streamUrl()
    streamPath: '/vnc.html',
    streamTtlSeconds: 3600,
    typingDelayMs: 12,
  },
});
```

With `computer` set, the sandbox defaults to the `agent37-ubuntu` template: an Ubuntu VM running XFCE and Firefox on a 1440x900 TigerVNC display. `sandbox.computer` implements Mastra's `SandboxComputer`:

| Method                                                | Notes                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `screenshot()`                                        | PNG of the whole display.                                                                                |
| `leftClick`, `rightClick`, `doubleClick`, `moveMouse` | Pixel coordinates, rounded and clamped at 0.                                                             |
| `drag(from, to)`                                      | Press, move through the midpoint, release.                                                               |
| `scroll(direction, amount)`                           | Wheel ticks.                                                                                             |
| `type(text)`                                          | Any Unicode text; sent base64-encoded, so quotes and shell characters are safe.                          |
| `press(key)`                                          | `'Enter'`, `'ctrl+s'`, `['cmd', 'Enter']`, `'ctrl++'`. Browser and Mastra key names map to X keysyms.    |
| `getScreenSize()`, `getCursorPosition()`              |                                                                                                          |
| `streamUrl()`                                         | Signed noVNC URL to watch or take over the desktop. Anyone holding it has full control until it expires. |

Agent37 provides the VM and desktop but no desktop-control API, so actions run `xdotool` and `scrot` as root over exec. The first action installs them with `apt-get` when the image lacks them, which adds a few seconds once and needs outbound network. Bake them into a custom template for `network: 'deny-all'` instances, or set `autoInstall: false`.

Each action is one exec round trip. Mastra's computer tools take a screenshot after every action by default; tune that per tool with the workspace `tools` option (`screenshotAfterAction`, `screenshotDelayMs`).

Any template with an X server works: set `template` and, when auto-detection doesn't find it, `computer.display`.

## Running agents inside Agent37

Every Agent37 instance gets a managed LLM router (OpenRouter models at cost, billed to the instance budget) in its environment, so an agent that runs inside an instance needs no model-provider key. [`examples/agent37-managed-model.ts`](examples/agent37-managed-model.ts) wraps it as a Mastra model:

```ts
import { agent37ManagedModel } from './agent37-managed-model';

const agent = new Agent({ model: agent37ManagedModel('anthropic/claude-haiku-4.5'), workspace /* ... */ });
```

The router speaks OpenAI chat completions, where tool results can only be text. Without the adapter, each screenshot from a computer tool reaches the model as base64 text (one run hit 228k prompt tokens after seven actions). The adapter moves tool-result images into user messages as real image inputs and keeps the newest three. The same task then used 32k input tokens in total.

`pnpm example:in-agent37 examples/computer-use-agent.ts` uploads the examples to a fresh runner instance with a small budget, runs one there, and deletes the runner. Grant headroom with `--budget-usd` (default 1).

## Cost

Agent37 bills running instances by shape and stopped or sleeping instances for disk only. To keep test and agent runs cheap:

- keep `autoSleep` on (the default) and pick an `idleTimeoutSeconds` that matches your traffic;
- stop sandboxes you'll come back to (`_stop()`), destroy the ones you won't (`_destroy()`);
- tag throwaway instances (`metadata: { mastra_test: '1' }`) and sweep them with `pnpm sweep:test-instances`;
- the `agent37-ubuntu` VM is larger than `agent37-base`; only enable `computer` when the agent needs a screen.

## Limitations

These come from Agent37's API, not from Mastra:

- **No streaming exec, stdin, or signal API.** Streaming, stdin, and kill are built from polling and files inside the instance, so output arrives in bursts and each stdin write is one exec call.
- **Stop kills processes.** With `stopMode: 'stop'` (or when Agent37 stops an instance), background processes are lost and their handles finish with exit code 137. Sleep keeps them.
- **No files API outside agent templates.** File operations run over exec with base64 chunks, which is slower than a native file API for large files.
- **No desktop-control API.** Computer use relies on `xdotool` and `scrot` inside the VM.
- **Managed LLM router only inside instances.** It rejects calls from outside Agent37.
- **No filesystem mounts.** The sandbox does not implement Mastra's `mount()` (S3, GCS) yet.

## Troubleshooting

**`Agent37 API key is missing`**: set `AGENT37_API_KEY` or pass `apiKey`.

**`Agent37 desktop is not available ... no X display found`**: the template has no desktop. Use the default `agent37-ubuntu` (with `type: 'vm'`), or set `computer.display`.

**`... installing xdotool and scrot needs outbound network access`**: the instance cannot reach apt mirrors. Allow network, or use a custom image that ships `xdotool` and `scrot`.

**A background process finished with exit code 137 and "process state was lost"**: the instance was stopped or recreated under it. Use `stopMode: 'sleep'` to keep processes across a stop.

**My script exits right after stopping a sandbox**: that's expected. Polling loops don't keep Node.js alive once the sandbox is stopped or destroyed.

**Leaked instances after a crashed test run**: `AGENT37_API_KEY=... pnpm sweep:test-instances --dry-run`, then without `--dry-run`.

## Examples

Run any example with `pnpm example <file>` (needs `AGENT37_API_KEY`):

| Example                                                       | Shows                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`basic-commands.ts`](examples/basic-commands.ts)             | Commands, exit codes, streaming, files through a `Workspace`            |
| [`persistent-workspace.ts`](examples/persistent-workspace.ts) | Reconnecting by id across runs, sleep on stop, deleting by id           |
| [`background-processes.ts`](examples/background-processes.ts) | A web server behind a signed URL, stdin, listing and killing processes  |
| [`computer-use-agent.ts`](examples/computer-use-agent.ts)     | A Mastra agent that opens a terminal on the desktop and types a command |

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test:unit   # no network: an in-memory Agent37 fake runs exec scripts in a local shell
pnpm build

AGENT37_API_KEY=sk_live_... pnpm test   # live integration suite (creates and deletes instances)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
