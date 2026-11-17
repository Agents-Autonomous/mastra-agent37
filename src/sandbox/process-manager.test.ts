/**
 * Process manager tests. The fake Agent37 runs exec scripts in the local
 * shell, so the spawn, poll, stdin, and kill scripts run for real (Linux
 * with util-linux setsid is required; the suite skips elsewhere).
 */
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { Agent37Client } from '../client';
import { FakeAgent37, localExec } from '../test-utils/fake-agent37';
import { Agent37Sandbox } from './index';
import type { Agent37ProcessHandle } from './process-manager';

const hasSetsid = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v setsid && command -v mkfifo && command -v timeout']);
    return true;
  } catch {
    return false;
  }
})();

function setup(processes = { quickWaitMs: 300, pollWindowMs: 500 }) {
  const fake = new FakeAgent37();
  const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch, retryBaseDelayMs: 1 });
  const sandbox = new Agent37Sandbox({ client, processes });
  return { fake, sandbox };
}

describe.skipIf(!hasSetsid)('Agent37ProcessManager (local shell)', () => {
  it('runs commands through executeCommand with quoted args', async () => {
    const { sandbox } = setup();
    const result = await sandbox.executeCommand!('printf', ['%s|%s', "it's", 'a b']);
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: "it's|a b", stderr: '' });
    expect(result.command).toBe("printf '%s|%s' 'it'\\''s' 'a b'");
  });

  it('reports exit codes and stderr', async () => {
    const { sandbox } = setup();
    const result = await sandbox.executeCommand!('echo out; echo err >&2; exit 7');
    expect(result).toMatchObject({ success: false, exitCode: 7, stdout: 'out\n', stderr: 'err\n' });
  });

  it('applies cwd, per-command env, sandbox env, and workingDirectory', async () => {
    const fake = new FakeAgent37();
    const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch });
    const sandbox = new Agent37Sandbox({ client, env: { A: 'sandbox', B: 'sandbox' }, workingDirectory: '/' });
    sandbox.setEnv(env => ({ ...env, C: "with 'quotes' and $dollar" }));
    const result = await sandbox.executeCommand!('pwd; echo "$A $B"; echo "$C"', [], { env: { B: 'call' } });
    expect(result.stdout).toBe("/\nsandbox call\nwith 'quotes' and $dollar\n");
    const inTmp = await sandbox.executeCommand!('pwd', [], { cwd: '/tmp' });
    expect(inTmp.stdout.trim()).toBe('/tmp');
    const missing = await sandbox.executeCommand!('pwd', [], { cwd: '/does/not/exist' });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/can't cd|No such file/);
  });

  it('streams output while the command runs', async () => {
    const { sandbox } = setup();
    const seen: Array<{ at: number; data: string }> = [];
    const start = Date.now();
    const result = await sandbox.executeCommand!('echo one; sleep 1; echo two; sleep 1; echo three >&2', [], {
      onStdout: data => seen.push({ at: Date.now() - start, data }),
      onStderr: data => seen.push({ at: Date.now() - start, data: 'ERR:' + data }),
    });
    expect(result.stdout).toBe('one\ntwo\n');
    expect(seen.map(s => s.data).join('')).toBe('one\ntwo\nERR:three\n');
    // The first line arrives well before the command finishes.
    expect(seen[0]!.at).toBeLessThan(1500);
  });

  it('kills a command that exceeds its timeout', async () => {
    const { sandbox } = setup();
    const result = await sandbox.executeCommand!('sleep 30', [], { timeout: 500 });
    expect(result).toMatchObject({ success: false, exitCode: 124, timedOut: true, killed: true });
  });

  it('counts the initial spawn wait against the timeout', async () => {
    const { sandbox } = setup({ quickWaitMs: 1000, pollWindowMs: 500 });
    const result = await sandbox.executeCommand('sleep 0.6; echo late', [], { timeout: 200 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(result.stdout).toBe('');
  });

  it('does not leave environment values on disk', async () => {
    const { sandbox } = setup();
    const handle = (await sandbox.processes.spawn('echo "$SECRET_TOKEN"; sleep 5', {
      env: { SECRET_TOKEN: 'tok-' + 'xyz123' },
    })) as Agent37ProcessHandle;
    await new Promise(r => setTimeout(r, 300));
    expect((await sandbox.processes.get(handle.pid))?.stdout).toBe('tok-xyz123\n');
    const dir = '/tmp/.mastra-agent37/proc/' + handle.handleId;
    const leaked = await localExec({ command: `grep -rl "tok-xyz123" ${dir} 2>/dev/null | grep -v "/out" || true` });
    expect(leaked.stdout.trim()).toBe('');
    const mode = await localExec({ command: `stat -c %a ${dir}` });
    expect(mode.stdout.trim()).toBe('700');
    await handle.kill();
  });

  it('finishes processes when the instance is stopped outside this sandbox', async () => {
    const { fake, sandbox } = setup();
    const handle = await sandbox.processes.spawn('sleep 30');
    fake.instances.get(sandbox.instanceId!)!.status = 'stopped';
    const result = await handle.wait();
    expect(result.exitCode).toBe(137);
    expect(result.stderr).toContain('stopped or deleted');
    await localExec({ command: `kill -9 -${handle.pid} 2>/dev/null; true` });
  });

  it('cleans up only state of processes that finished more than a day ago', async () => {
    const { sandbox } = setup();
    const root = '/tmp/.mastra-agent37/proc';
    await localExec({
      command: [
        `mkdir -p ${root}/oldfinished ${root}/oldrunning`,
        `echo 0 > ${root}/oldfinished/exit; echo 1 > ${root}/oldrunning/pid`,
        `touch -d '2 days ago' ${root}/oldfinished/exit ${root}/oldfinished ${root}/oldrunning/pid ${root}/oldrunning`,
      ].join('; '),
    });
    await sandbox.executeCommand('true');
    const left = await localExec({ command: `ls ${root}` });
    expect(left.stdout).not.toContain('oldfinished');
    expect(left.stdout).toContain('oldrunning');
    await localExec({ command: `rm -rf ${root}/oldrunning` });
  });

  it('applies the sandbox default timeout', async () => {
    const fake = new FakeAgent37();
    const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch });
    const sandbox = new Agent37Sandbox({ client, timeout: 400, processes: { quickWaitMs: 100, pollWindowMs: 200 } });
    const result = await sandbox.executeCommand!('sleep 30');
    expect(result.timedOut).toBe(true);
  });

  it('aborts a command through its abort signal', async () => {
    const { sandbox } = setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await sandbox.executeCommand!('sleep 30', [], { abortSignal: controller.signal });
    expect(result.killed).toBe(true);
    expect(result.success).toBe(false);
  });

  it('spawns, lists, reads, and kills background processes', async () => {
    const { sandbox } = setup();
    const handle = await sandbox.processes.spawn('echo started; sleep 30');
    expect(handle.exitCode).toBeUndefined();
    expect(handle.pid).toMatch(/^\d+$/);
    const listed = await sandbox.processes.list();
    expect(listed).toEqual([
      { pid: handle.pid, command: 'echo started; sleep 30', running: true, exitCode: undefined },
    ]);
    expect((await sandbox.processes.get(handle.pid))?.stdout).toBe('started\n');
    expect(await sandbox.processes.kill(handle.pid)).toBe(true);
    expect(handle.exitCode).toBe(143);
    expect(await sandbox.processes.get(handle.pid)).toBeUndefined();
    expect(await sandbox.processes.kill(handle.pid)).toBe(false);
  });

  it('kills the whole process group, including children', async () => {
    const { sandbox } = setup();
    const marker = 'agent37-child-' + Date.now();
    const handle = await sandbox.processes.spawn(`sh -c 'sleep 31; echo ${marker}' & wait`);
    await handle.kill();
    const after = await localExec({ command: `ps -eo args | grep -c "sleep 3[1]" || true` });
    expect(after.stdout.trim()).toBe('0');
    await expect(handle.kill()).resolves.toBe(false);
  });

  it('pipes stdin and closes it', async () => {
    const { sandbox } = setup();
    const handle = await sandbox.processes.spawn('tr a-z A-Z');
    await handle.sendStdin('hello ');
    await handle.sendStdin('world\n');
    await handle.closeStdin();
    const result = await handle.wait();
    expect(result.stdout).toBe('HELLO WORLD\n');
    await expect(handle.sendStdin('late')).rejects.toThrow(/already exited/);
    await expect(handle.closeStdin()).resolves.toBeUndefined();
  });

  it('treats closing stdin of a process that already exited, or twice, as a no-op', async () => {
    const { sandbox } = setup();
    const reader = await sandbox.processes.spawn('read line; echo "got $line"');
    await reader.sendStdin('one\n');
    await new Promise(r => setTimeout(r, 300));
    await reader.closeStdin();
    await reader.closeStdin();
    expect((await reader.wait()).stdout).toBe('got one\n');
  });

  it('supports the writer stream for stdin', async () => {
    const { sandbox } = setup();
    const handle = await sandbox.processes.spawn('cat');
    handle.writer.write('via writer\n');
    handle.writer.end();
    const result = await handle.wait();
    expect(result.stdout).toBe('via writer\n');
  });

  it("rejects stdin for processes spawned with stdinMode 'ignore'", async () => {
    const { sandbox } = setup();
    const handle = await sandbox.processes.spawn('sleep 5', { stdinMode: 'ignore' });
    await expect(handle.sendStdin('x')).rejects.toThrow(/stdinMode 'ignore'/);
    await handle.kill();
  });

  it('gives commands that read stdin immediate EOF under executeCommand', async () => {
    const { sandbox } = setup();
    const result = await sandbox.executeCommand!('cat; echo done');
    expect(result.stdout).toBe('done\n');
  });

  it('collects output larger than one frame and keeps multibyte characters intact', async () => {
    const { sandbox } = setup();
    const result = await sandbox.executeCommand!(
      "i=0; while [ $i -lt 60000 ]; do printf 'é漢字-%05d\\n' $i; i=$((i+1)); done",
      [],
      { maxRetainedBytes: Infinity },
    );
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(60000);
    expect(lines[59999]).toBe('é漢字-59999');
    expect(result.stdout).not.toContain('\ufffd');
  }, 60_000);

  it('notifies onStdout for background processes without anyone waiting', async () => {
    const { sandbox } = setup();
    const chunks: string[] = [];
    const handle = await sandbox.processes.spawn('sleep 0.5; echo later', { onStdout: d => chunks.push(d) });
    await new Promise(r => setTimeout(r, 2500));
    expect(chunks.join('')).toBe('later\n');
    expect(handle.exitCode).toBe(0);
  });

  it('reports a process whose state vanished as exit 137', async () => {
    const { sandbox } = setup();
    const handle = (await sandbox.processes.spawn('sleep 5')) as Agent37ProcessHandle;
    await localExec({ command: `rm -rf /tmp/.mastra-agent37/proc/${handle.handleId}; kill -9 -${handle.pid}` });
    const result = await handle.wait();
    expect(result.exitCode).toBe(137);
    expect(result.stderr).toContain('process state was lost');
  });

  it('removes a released process directory', async () => {
    const { sandbox } = setup();
    const handle = (await sandbox.processes.spawn('true')) as Agent37ProcessHandle;
    await handle.wait();
    sandbox.processes.release(handle.pid);
    await new Promise(r => setTimeout(r, 300));
    const check = await localExec({ command: `test -e /tmp/.mastra-agent37/proc/${handle.handleId}; echo $?` });
    expect(check.stdout.trim()).toBe('1');
  });

  it('finishes running processes when the sandbox is stopped or destroyed', async () => {
    const fake = new FakeAgent37();
    const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch });
    const sandbox = new Agent37Sandbox({
      client,
      stopMode: 'stop',
      processes: { quickWaitMs: 100, pollWindowMs: 200 },
    });
    const handle = await sandbox.processes.spawn('sleep 30');
    await sandbox._stop();
    expect((await handle.wait()).exitCode).toBe(137);
    await localExec({ command: `kill -9 -${handle.pid} 2>/dev/null; true` });

    const other = new Agent37Sandbox({ client, processes: { quickWaitMs: 100, pollWindowMs: 200 } });
    const second = await other.processes.spawn('sleep 30');
    await other._destroy();
    expect((await second.wait()).stderr).toContain('destroyed');
    await localExec({ command: `kill -9 -${second.pid} 2>/dev/null; true` });
  });

  it('fails spawn with the script error', async () => {
    const { fake, sandbox } = setup();
    await sandbox.start();
    fake.execHandler = () => ({ exit_code: 91, stdout: '', stderr: 'process failed to start', truncated: false });
    await expect(sandbox.processes.spawn('true')).rejects.toThrow(/process failed to start/);
  });

  it('sends spawn with an idempotency name', async () => {
    const { fake, sandbox } = setup();
    await sandbox.executeCommand!('true');
    const spawn = fake.callsTo('POST', /exec$/).find(c => String(c.body.command).includes('w.sh'));
    expect(spawn!.body.name).toMatch(/^mastra-spawn-[a-z0-9]{16}$/);
  });

  it('keeps polling through transient poll failures', async () => {
    const { fake, sandbox } = setup();
    const handle = await sandbox.processes.spawn('sleep 1; echo ok');
    fake.fail(c => c.path.endsWith('/exec') && !String(c.body.command).includes('w.sh'), 503, 'wake_failed', 1);
    expect((await handle.wait()).stdout).toBe('ok\n');
  });
});
