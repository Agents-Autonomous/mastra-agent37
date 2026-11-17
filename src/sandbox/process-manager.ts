/**
 * Agent37 Process Manager
 *
 * Implements SandboxProcessManager on top of Agent37's exec endpoint. Each
 * spawn() starts a detached process group inside the instance and returns
 * immediately; output streams back through long-polling execs (see
 * `process-scripts.ts`). stdin is supported through a FIFO.
 */

import { ProcessHandle, SandboxProcessManager } from '@mastra/core/workspace';
import type { CommandResult, ProcessInfo, SpawnProcessOptions } from '@mastra/core/workspace';

import { randomId } from '../utils/shell';
import {
  FRAME_CHUNK_BYTES,
  LOST_EXIT_CODE,
  SCRIPT_EXIT,
  cleanupScript,
  closeStdinScript,
  killScript,
  parseFrame,
  pollScript,
  sendStdinScript,
  spawnScript,
} from './process-scripts';
import type { ProcessFrame } from './process-scripts';
import type { Agent37Sandbox } from './index';

/** Tuning for how process output is collected. */
export interface Agent37ProcessOptions {
  /** How long the spawn call waits for a short command to finish before returning, in ms. Default: 1000. */
  quickWaitMs?: number;
  /** Longest a single output long-poll waits inside the instance, in ms. Default: 5000. */
  pollWindowMs?: number;
  /** Most bytes sendStdin() sends per exec call. Default: 256 KiB. */
  stdinChunkBytes?: number;
}

const DEFAULTS: Required<Agent37ProcessOptions> = {
  quickWaitMs: 1000,
  pollWindowMs: 5000,
  stdinChunkBytes: 256 * 1024,
};

/** Consecutive frames reporting a dead process with no exit code before it is declared lost. */
const LOST_FRAMES = 3;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A sleep that does not keep the Node.js process alive on its own. */
const idle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref?.());

// =============================================================================
// Process Handle
// =============================================================================

/** Handle to a process running inside an Agent37 instance. */
export class Agent37ProcessHandle extends ProcessHandle {
  readonly pid: string;
  /** Id of the process's state directory inside the instance. */
  readonly handleId: string;

  readonly #manager: Agent37ProcessManager;
  readonly #startTime: number;
  readonly #timeout?: number;
  readonly #stdoutDecoder = new TextDecoder('utf-8');
  readonly #stderrDecoder = new TextDecoder('utf-8');
  #stdoutOffset = 0;
  #stderrOffset = 0;
  #exitCode: number | undefined;
  #killed = false;
  #timedOut = false;
  #lostFrames = 0;
  #done!: Promise<void>;
  #resolveDone!: () => void;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    manager: Agent37ProcessManager,
    handleId: string,
    frame: ProcessFrame,
    startTime: number,
    options: SpawnProcessOptions,
  ) {
    super(options);
    this.#manager = manager;
    this.handleId = handleId;
    this.pid = frame.pid ?? handleId;
    this.#startTime = startTime;
    this.#timeout = options.timeout;
    this.#done = new Promise(resolve => {
      this.#resolveDone = resolve;
    });
    this.applyFrame(frame);
    if (this.#exitCode === undefined) {
      if (this.#timeout) {
        // The deadline counts from the spawn request, so time spent in the spawn's initial wait is included.
        this.#timer = setTimeout(() => void this.#onTimeout(), Math.max(0, this.#timeout - (Date.now() - startTime)));
        this.#timer.unref?.();
      }
      void this.#pollLoop();
    }
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /**
   * Apply a frame read from offsets `stdoutFrom`/`stderrFrom`. A concurrent
   * read (the poll loop and kill's drain) may return bytes already applied;
   * only the part past the current offsets is emitted. Returns true when more
   * output is pending. @internal
   */
  applyFrame(frame: ProcessFrame, stdoutFrom = 0, stderrFrom = 0): boolean {
    if (frame.missing) {
      this.#finish(
        LOST_EXIT_CODE,
        'process state was lost (the instance was rebooted or the process directory removed)',
      );
      return false;
    }
    const stdout = frame.stdout.subarray(Math.max(0, this.#stdoutOffset - stdoutFrom));
    if (stdoutFrom <= this.#stdoutOffset && stdout.length) {
      this.#stdoutOffset += stdout.length;
      const text = this.#stdoutDecoder.decode(stdout, { stream: true });
      if (text) this.emitStdout(text);
    }
    const stderr = frame.stderr.subarray(Math.max(0, this.#stderrOffset - stderrFrom));
    if (stderrFrom <= this.#stderrOffset && stderr.length) {
      this.#stderrOffset += stderr.length;
      const text = this.#stderrDecoder.decode(stderr, { stream: true });
      if (text) this.emitStderr(text);
    }
    const pending = this.#stdoutOffset < frame.stdoutSize || this.#stderrOffset < frame.stderrSize;
    if (pending) return true;
    if (frame.exitCode !== undefined) {
      this.#finish(frame.exitCode);
      return false;
    }
    if (!frame.alive) {
      this.#lostFrames += 1;
      if (this.#lostFrames >= LOST_FRAMES)
        this.#finish(LOST_EXIT_CODE, 'process exited without reporting an exit code');
    } else {
      this.#lostFrames = 0;
    }
    return false;
  }

  /** Mark the process as gone without asking the instance (it was stopped or destroyed). @internal */
  abandon(reason: string): void {
    this.#finish(LOST_EXIT_CODE, reason);
  }

  #finish(exitCode: number, reason?: string): void {
    if (this.#exitCode !== undefined) return;
    const tailOut = this.#stdoutDecoder.decode();
    if (tailOut) this.emitStdout(tailOut);
    const tailErr = this.#stderrDecoder.decode();
    if (tailErr) this.emitStderr(tailErr);
    if (reason) this.emitStderr(`${this.stderr && !this.stderr.endsWith('\n') ? '\n' : ''}[agent37] ${reason}\n`);
    this.#exitCode = this.#timedOut ? 124 : exitCode;
    if (this.#timer) clearTimeout(this.#timer);
    this.#resolveDone();
  }

  async #pollLoop(): Promise<void> {
    let failures = 0;
    let pending = false;
    while (this.#exitCode === undefined) {
      const status = this.#manager.sandbox.status;
      if (status === 'destroyed' || status === 'destroying') {
        this.#finish(LOST_EXIT_CODE, 'sandbox was destroyed');
        return;
      }
      if (status !== 'running') {
        // Never wake a stopped or sleeping instance just to read output.
        await idle(1000);
        continue;
      }
      try {
        pending = (await this.#readFrame(pending ? 0 : this.#manager.options.pollWindowMs)).pending;
        failures = 0;
      } catch (error) {
        failures += 1;
        if (await this.#manager.sandbox.isInstanceHaltedError(error)) {
          this.#finish(LOST_EXIT_CODE, 'the Agent37 instance was stopped or deleted');
          return;
        }
        await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  async #onTimeout(): Promise<void> {
    if (this.#exitCode !== undefined) return;
    this.#timedOut = true;
    await this.kill().catch(() => {});
  }

  async wait(): Promise<CommandResult> {
    await this.#done;
    const exitCode = this.#exitCode ?? LOST_EXIT_CODE;
    return {
      success: exitCode === 0 && !this.#killed,
      exitCode,
      stdout: this.stdout,
      stderr: this.#timedOut && !this.stderr ? `Command timed out after ${this.#timeout}ms` : this.stderr,
      executionTimeMs: Date.now() - this.#startTime,
      ...(this.#killed && { killed: true }),
      ...(this.#timedOut && { timedOut: true }),
    };
  }

  async kill(): Promise<boolean> {
    if (this.#exitCode !== undefined) return false;
    this.#killed = true;
    const result = await this.#manager.sandbox.runScript(killScript(this.handleId), { retryOnDead: false });
    if (result.exit_code === SCRIPT_EXIT.notRunning) {
      // Already exiting: let the poll loop collect the real exit code.
      await Promise.race([this.#done, sleep(2000)]);
      if (this.#exitCode === undefined) this.#finish(LOST_EXIT_CODE);
      return true;
    }
    // Collect the remaining output and the exit code the wrapper wrote.
    await this.#drain();
    return true;
  }

  async #readFrame(waitMs: number): Promise<{ frame: ProcessFrame; pending: boolean }> {
    const stdoutFrom = this.#stdoutOffset;
    const stderrFrom = this.#stderrOffset;
    const result = await this.#manager.sandbox.runScript(pollScript(this.handleId, stdoutFrom, stderrFrom, waitMs), {
      retryOnDead: false,
    });
    const frame = parseFrame(result.stdout);
    return { frame, pending: this.applyFrame(frame, stdoutFrom, stderrFrom) };
  }

  async #drain(): Promise<void> {
    for (let i = 0; i < 20 && this.#exitCode === undefined; i++) {
      const { frame, pending } = await this.#readFrame(0);
      if (this.#exitCode === undefined && !pending && frame.exitCode === undefined) await sleep(100);
    }
    if (this.#exitCode === undefined) this.#finish(LOST_EXIT_CODE);
  }

  async sendStdin(data: string): Promise<void> {
    if (this.#exitCode !== undefined) throw new Error(`Process ${this.pid} has already exited`);
    const bytes = Buffer.from(data, 'utf-8');
    const chunk = this.#manager.options.stdinChunkBytes;
    for (let start = 0; start < bytes.length || start === 0; start += chunk) {
      const result = await this.#manager.sandbox.runScript(
        sendStdinScript(this.handleId, bytes.subarray(start, start + chunk)),
        { retryOnDead: false },
      );
      this.#assertStdinResult(result.exit_code, result.stderr, 'send stdin to');
      if (bytes.length === 0) break;
    }
  }

  /** Signal EOF. Closing the stdin of a process that already exited, or closing it twice, does nothing. */
  async closeStdin(): Promise<void> {
    if (this.#exitCode !== undefined) return;
    const result = await this.#manager.sandbox.runScript(closeStdinScript(this.handleId), { retryOnDead: false });
    if (result.exit_code === SCRIPT_EXIT.notRunning || result.exit_code === SCRIPT_EXIT.stdinClosed) return;
    this.#assertStdinResult(result.exit_code, result.stderr, 'close stdin of');
  }

  #assertStdinResult(exitCode: number, stderr: string, action: string): void {
    if (exitCode === 0) return;
    if (exitCode === SCRIPT_EXIT.notRunning)
      throw new Error(`Cannot ${action} process ${this.pid}: it has already exited`);
    if (exitCode === SCRIPT_EXIT.noStdin) {
      throw new Error(`Cannot ${action} process ${this.pid}: it was spawned with stdinMode 'ignore'`);
    }
    if (exitCode === SCRIPT_EXIT.stdinClosed) throw new Error(`Cannot ${action} process ${this.pid}: stdin is closed`);
    throw new Error(`Failed to ${action} process ${this.pid} (exit ${exitCode}): ${stderr.trim()}`);
  }
}

// =============================================================================
// Process Manager
// =============================================================================

/** Agent37 implementation of SandboxProcessManager. */
export class Agent37ProcessManager extends SandboxProcessManager<Agent37Sandbox> {
  readonly options: Required<Agent37ProcessOptions>;

  constructor(options: Agent37ProcessOptions = {}) {
    super();
    this.options = { ...DEFAULTS, ...options };
  }

  async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    const handleId = randomId(16);
    const startTime = Date.now();
    const result = await this.sandbox.runScript(
      spawnScript({
        handleId,
        command,
        cwd: options.cwd ?? this.sandbox.workingDirectory,
        env: options.env,
        stdin: options.stdinMode ?? 'pipe',
        quickWaitMs: Math.min(this.options.quickWaitMs, options.timeout ?? Infinity),
      }),
      // The name makes a resend after a dropped connection return this spawn's result instead of starting a second copy.
      { name: `mastra-spawn-${handleId}` },
    );
    if (result.exit_code !== 0) {
      throw new Error(
        `Failed to spawn process (exit ${result.exit_code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const handle = new Agent37ProcessHandle(this, handleId, parseFrame(result.stdout), startTime, options);
    this._tracked.set(handle.pid, handle);
    return handle;
  }

  async list(): Promise<ProcessInfo[]> {
    return Array.from(this._tracked.values(), handle => ({
      pid: handle.pid,
      command: handle.command,
      running: handle.exitCode === undefined,
      exitCode: handle.exitCode,
    }));
  }

  /** Finish every running handle with exit code 137, after a stop or destroy ended their processes. @internal */
  abandonAll(reason: string): void {
    for (const handle of this._tracked.values()) {
      if (handle instanceof Agent37ProcessHandle && handle.exitCode === undefined) handle.abandon(reason);
    }
  }

  /** Stop tracking a process and remove its state directory once it has exited. */
  override release(pid: string): void {
    const handle = this._tracked.get(pid);
    super.release(pid);
    if (handle instanceof Agent37ProcessHandle && handle.exitCode !== undefined && this.sandbox.status === 'running') {
      void this.sandbox.runScript(cleanupScript(handle.handleId), { retryOnDead: false }).catch(() => {});
    }
  }
}

export { FRAME_CHUNK_BYTES };
