/**
 * Shell scripts behind {@link Agent37ProcessManager}.
 *
 * Agent37's exec endpoint runs one `sh -c` command and returns its whole
 * output when it exits; it has no output stream, stdin channel, or signal
 * API. Background processes are built on top of it:
 *
 * - `spawn` writes a small runner into a per-process directory and starts a
 *   detached wrapper (`setsid`) that runs the command as its own process
 *   group, with stdout and stderr redirected to files and the exit code
 *   written to a file when it finishes. The same exec waits briefly so short
 *   commands finish in one round trip.
 * - `poll` long-polls inside the VM until new output arrives, the process
 *   exits, or the window ends, then returns the new bytes from both files as
 *   base64, so output streams to the host with one exec per batch.
 * - stdin (when piped) is a FIFO held open by a holder process; `sendStdin`
 *   writes into the FIFO and `closeStdin` kills the holder to deliver EOF.
 * - `kill` signals the whole process group: SIGTERM, then SIGKILL after ~2s.
 *
 * Every script prints at most a bounded amount of output, which keeps each
 * exec response well under Agent37's 512 KB stdout cap.
 */

import { posix } from 'node:path';

import { envAssignments, shellQuote } from '../utils/shell';

/** Root directory for per-process state inside the instance. */
export const PROCESS_ROOT = '/tmp/.mastra-agent37/proc';

/** Most bytes of each stream one frame carries (base64 inflates it by 4/3). */
export const FRAME_CHUNK_BYTES = 160 * 1024;

/** Exit codes the scripts use for outcomes the host maps to errors. */
export const SCRIPT_EXIT = {
  notRunning: 3,
  noStdin: 4,
  stdinClosed: 5,
  startFailed: 91,
} as const;

/** Exit code reported when a process disappears without writing an exit code (instance rebooted or killed). */
export const LOST_EXIT_CODE = 137;

export interface RunnerOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** The runner script: change into `cwd`, then exec the command through `sh -c` with the merged environment. */
export function runnerScript({ command, cwd, env }: RunnerOptions): string {
  const lines: string[] = [];
  if (cwd) lines.push(`cd ${shellQuote(cwd)} || exit 1`);
  const assignments = envAssignments(env);
  const envPrefix = assignments.length ? `env ${assignments.join(' ')} ` : '';
  lines.push(`exec ${envPrefix}sh -c ${shellQuote(command)}`);
  return lines.join('\n') + '\n';
}

/**
 * The wrapper runs detached as `setsid sh w.sh DIR MODE`. It starts the
 * runner as its own session (so `kill -PID` reaches the whole tree),
 * records the pid, waits, and writes the exit code atomically.
 */
const WRAPPER_SCRIPT = [
  'D="$1"; MODE="$2"',
  'if [ "$MODE" = pipe ]; then',
  '  mkfifo "$D/in" || exit 1',
  '  setsid sh "$D/run.sh" <"$D/in" >"$D/out" 2>"$D/err" &',
  '  child=$!',
  '  echo "$child" > "$D/pid"',
  '  sleep 2147483647 >"$D/in" 2>/dev/null &',
  '  echo $! > "$D/holder"',
  'else',
  '  setsid sh "$D/run.sh" </dev/null >"$D/out" 2>"$D/err" &',
  '  child=$!',
  '  echo "$child" > "$D/pid"',
  'fi',
  'wait "$child"; code=$?',
  '[ -f "$D/holder" ] && kill "$(cat "$D/holder")" 2>/dev/null',
  'echo "$code" > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
  '',
].join('\n');

/** Shell that prints one frame for the process in `$D` starting at offsets `$O` (stdout) and `$E` (stderr). */
function emitFrame(): string {
  return [
    'ex=-; [ -f "$D/exit" ] && ex=$(cat "$D/exit")',
    'alive=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1',
    'so=$(wc -c <"$D/out" 2>/dev/null || echo 0); se=$(wc -c <"$D/err" 2>/dev/null || echo 0)',
    'echo "A37P $pid $ex $so $se $alive"',
    `tail -c +$((O+1)) "$D/out" 2>/dev/null | head -c ${FRAME_CHUNK_BYTES} | base64 | tr -d '\\n'; echo`,
    `tail -c +$((E+1)) "$D/err" 2>/dev/null | head -c ${FRAME_CHUNK_BYTES} | base64 | tr -d '\\n'; echo`,
  ].join('\n');
}

export function processDir(handleId: string): string {
  return posix.join(PROCESS_ROOT, handleId);
}

export interface SpawnScriptOptions extends RunnerOptions {
  handleId: string;
  stdin: 'pipe' | 'ignore';
  /** How long the spawn exec waits for the process to exit before returning, in ms. */
  quickWaitMs: number;
}

/** Start the process and return its first frame. Safe to resend: a second run reports the existing process. */
export function spawnScript(options: SpawnScriptOptions): string {
  const dir = processDir(options.handleId);
  const runner = Buffer.from(runnerScript(options)).toString('base64');
  const wrapper = Buffer.from(WRAPPER_SCRIPT).toString('base64');
  const quickTicks = Math.max(0, Math.ceil(options.quickWaitMs / 50));
  return [
    `D=${shellQuote(dir)}; O=0; E=0`,
    'if [ ! -e "$D/pid" ]; then',
    `  mkdir -p ${shellQuote(PROCESS_ROOT)} && chmod 1777 ${shellQuote(posix.dirname(PROCESS_ROOT))} ${shellQuote(PROCESS_ROOT)} 2>/dev/null`,
    `  find ${shellQuote(PROCESS_ROOT)} -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null`,
    `  mkdir -p "$D" || exit ${SCRIPT_EXIT.startFailed}`,
    `  printf %s ${shellQuote(runner)} | base64 -d > "$D/run.sh"`,
    `  printf %s ${shellQuote(wrapper)} | base64 -d > "$D/w.sh"`,
    '  : > "$D/out"; : > "$D/err"',
    `  setsid sh "$D/w.sh" "$D" ${options.stdin} >/dev/null 2>&1 </dev/null &`,
    '  i=0; while [ ! -s "$D/pid" ] && [ $i -lt 500 ]; do sleep 0.01; i=$((i+1)); done',
    'fi',
    `[ -s "$D/pid" ] || { echo "process failed to start" >&2; exit ${SCRIPT_EXIT.startFailed}; }`,
    'pid=$(cat "$D/pid")',
    `i=0; while [ ! -f "$D/exit" ] && [ $i -lt ${quickTicks} ]; do sleep 0.05; i=$((i+1)); done`,
    emitFrame(),
  ].join('\n');
}

/** Long-poll for new output or exit, up to `waitMs`, then print one frame. */
export function pollScript(handleId: string, stdoutOffset: number, stderrOffset: number, waitMs: number): string {
  const ticks = Math.max(0, Math.ceil(waitMs / 50));
  return [
    `D=${shellQuote(processDir(handleId))}; O=${stdoutOffset}; E=${stderrOffset}`,
    '[ -d "$D" ] || { echo "A37P - missing"; exit 0; }',
    'pid=$(cat "$D/pid" 2>/dev/null)',
    'i=0',
    `while [ $i -lt ${ticks} ]; do`,
    '  [ -f "$D/exit" ] && break',
    '  [ "$(wc -c <"$D/out")" -gt "$O" ] && break',
    '  [ "$(wc -c <"$D/err")" -gt "$E" ] && break',
    '  kill -0 "$pid" 2>/dev/null || break',
    '  sleep 0.05; i=$((i+1))',
    'done',
    emitFrame(),
  ].join('\n');
}

/** SIGTERM the process group, escalate to SIGKILL after ~2s, and wait for the exit code. Exits 3 when not running. */
export function killScript(handleId: string): string {
  return [
    `D=${shellQuote(processDir(handleId))}`,
    `pid=$(cat "$D/pid" 2>/dev/null) || exit ${SCRIPT_EXIT.notRunning}`,
    `[ -f "$D/exit" ] && exit ${SCRIPT_EXIT.notRunning}`,
    `kill -0 "$pid" 2>/dev/null || exit ${SCRIPT_EXIT.notRunning}`,
    // dash's kill builtin rejects '--', so the group is addressed as a bare negative pid.
    'kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
    'i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done',
    'kill -KILL "-$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null',
    'i=0; while [ ! -f "$D/exit" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done',
    'exit 0',
  ].join('\n');
}

/** Append bytes to the process's stdin FIFO. Bounded by `timeout` so a process that stopped reading cannot hang the call. */
export function sendStdinScript(handleId: string, data: Uint8Array): string {
  return [
    `D=${shellQuote(processDir(handleId))}`,
    `[ -f "$D/exit" ] && exit ${SCRIPT_EXIT.notRunning}`,
    `[ -p "$D/in" ] || exit ${SCRIPT_EXIT.noStdin}`,
    `[ -f "$D/stdin-closed" ] && exit ${SCRIPT_EXIT.stdinClosed}`,
    `printf %s ${shellQuote(Buffer.from(data).toString('base64'))} | base64 -d | timeout 30 sh -c 'cat > "$1"' _ "$D/in"`,
  ].join('\n');
}

/** Close stdin: kill the FIFO's holder so the process reads EOF after the buffered bytes. */
export function closeStdinScript(handleId: string): string {
  return [
    `D=${shellQuote(processDir(handleId))}`,
    `[ -f "$D/exit" ] && exit ${SCRIPT_EXIT.notRunning}`,
    `[ -p "$D/in" ] || exit ${SCRIPT_EXIT.noStdin}`,
    'touch "$D/stdin-closed"',
    'kill "$(cat "$D/holder")" 2>/dev/null',
    'exit 0',
  ].join('\n');
}

/** Remove a finished process's directory. */
export function cleanupScript(handleId: string): string {
  return `rm -rf ${shellQuote(processDir(handleId))}`;
}

export interface ProcessFrame {
  pid?: string;
  missing: boolean;
  exitCode?: number;
  stdoutSize: number;
  stderrSize: number;
  alive: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

/** Parse the frame a spawn or poll script printed. Throws when the output is not a frame. */
export function parseFrame(output: string): ProcessFrame {
  const lines = output.split('\n');
  const headerIndex = lines.findIndex(line => line.startsWith('A37P '));
  if (headerIndex === -1) throw new Error(`Unexpected process frame: ${output.slice(0, 200)}`);
  const fields = lines[headerIndex]!.split(' ');
  if (fields[2] === 'missing') {
    return {
      missing: true,
      alive: false,
      stdoutSize: 0,
      stderrSize: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }
  const [, pid, exit, stdoutSize, stderrSize, alive] = fields;
  return {
    pid: pid && pid !== '-' ? pid : undefined,
    missing: false,
    exitCode: exit && exit !== '-' ? Number(exit) : undefined,
    stdoutSize: Number(stdoutSize) || 0,
    stderrSize: Number(stderrSize) || 0,
    alive: alive === '1',
    stdout: Buffer.from(lines[headerIndex + 1] ?? '', 'base64'),
    stderr: Buffer.from(lines[headerIndex + 2] ?? '', 'base64'),
  };
}
