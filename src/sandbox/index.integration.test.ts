/**
 * Integration tests against real Agent37 Cloud. They create instances, which
 * costs workspace credit, so they run only when AGENT37_API_KEY is set:
 *
 *   AGENT37_API_KEY=sk_live_... pnpm test
 *
 * Every instance is tagged mastra_test=1 and destroyed in afterAll; run
 * `pnpm sweep:test-instances` to remove anything a crashed run left behind.
 */
import { Workspace } from '@mastra/core/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Agent37Client } from '../client';
import { SANDBOX_ID_METADATA_KEY } from './index';
import { Agent37Sandbox } from './index';
import type { Agent37SandboxOptions } from './index';

const hasKey = Boolean(process.env.AGENT37_API_KEY);
const runId = Date.now().toString(36);
const created: Agent37Sandbox[] = [];

function testSandbox(name: string, options: Agent37SandboxOptions = {}): Agent37Sandbox {
  const sandbox = new Agent37Sandbox({
    id: `mastra-agent37-test-${name}-${runId}`,
    metadata: { mastra_test: '1' },
    idleTimeoutSeconds: 300,
    ...options,
  });
  created.push(sandbox);
  return sandbox;
}

afterAll(async () => {
  await Promise.allSettled(created.map(sandbox => sandbox._destroy()));
  if (!hasKey) return;
  const client = new Agent37Client();
  const leftovers = (await client.listInstances()).filter(instance =>
    instance.metadata?.[SANDBOX_ID_METADATA_KEY]?.endsWith(runId),
  );
  await Promise.allSettled(leftovers.map(instance => client.deleteInstance(instance.id)));
}, 120_000);

describe.skipIf(!hasKey)('Agent37Sandbox (live)', () => {
  let sandbox: Agent37Sandbox;

  beforeAll(async () => {
    sandbox = testSandbox('base');
    await sandbox._start();
  }, 180_000);

  it('creates a tagged instance and reports it', async () => {
    expect(sandbox.status).toBe('running');
    expect(sandbox.instance.template).toBe('agent37-base');
    expect(sandbox.instance.metadata).toMatchObject({ mastra_test: '1', [SANDBOX_ID_METADATA_KEY]: sandbox.id });
    const info = await sandbox.getInfo();
    expect(info).toMatchObject({ provider: 'agent37', status: 'running' });
    expect(info.metadata?.instanceId).toBe(sandbox.instanceId);
  });

  it('runs commands with exit codes, stderr, env, and cwd', async () => {
    const ok = await sandbox.executeCommand!('echo "$GREETING from $(pwd)"', [], { env: { GREETING: 'hello' }, cwd: '/tmp' });
    expect(ok).toMatchObject({ success: true, exitCode: 0, stdout: 'hello from /tmp\n' });
    const failed = await sandbox.executeCommand!('echo oops >&2; exit 3');
    expect(failed).toMatchObject({ success: false, exitCode: 3, stderr: 'oops\n' });
  });

  it('streams output and enforces timeouts', async () => {
    const start = Date.now();
    const seen: number[] = [];
    const result = await sandbox.executeCommand!('echo one; sleep 3; echo two', [], {
      onStdout: () => seen.push(Date.now() - start),
    });
    expect(result.stdout).toBe('one\ntwo\n');
    expect(seen[0]!).toBeLessThan(seen.at(-1)! - 1000);
    const slow = await sandbox.executeCommand!('sleep 60', [], { timeout: 2000 });
    expect(slow).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it('runs background processes with stdin and kill', async () => {
    const upper = await sandbox.processes.spawn('tr a-z A-Z');
    await upper.sendStdin('hello agent37\n');
    await upper.closeStdin();
    expect((await upper.wait()).stdout).toBe('HELLO AGENT37\n');

    const sleeper = await sandbox.processes.spawn('sleep 600');
    expect((await sandbox.processes.list()).some(p => p.pid === sleeper.pid && p.running)).toBe(true);
    expect(await sleeper.kill()).toBe(true);
    expect(sleeper.exitCode).toBe(143);
  });

  it('round-trips files, including one larger than an exec payload', async () => {
    const fs = sandbox.filesystem;
    const big = Buffer.alloc(1536 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    await fs.writeFile('/tmp/it/big.bin', big);
    expect(((await fs.readFile('/tmp/it/big.bin')) as Buffer).equals(big)).toBe(true);
    await fs.writeFile('/tmp/it/notes.md', '# hi\n');
    await fs.appendFile('/tmp/it/notes.md', 'more\n');
    await fs.copyFile('/tmp/it/notes.md', '/tmp/it/sub/copy.md');
    expect(await fs.readFile('/tmp/it/sub/copy.md', { encoding: 'utf-8' })).toBe('# hi\nmore\n');
    expect((await fs.readdir('/tmp/it', { recursive: true })).map(e => e.name)).toEqual([
      'big.bin',
      'notes.md',
      'sub',
      'sub/copy.md',
    ]);
    expect(await fs.stat('/tmp/it/big.bin')).toMatchObject({ type: 'file', size: big.length });
    await fs.rmdir('/tmp/it', { recursive: true });
    expect(await fs.exists('/tmp/it')).toBe(false);
  }, 120_000);

  it('serves a port through a signed URL', async () => {
    const server = await sandbox.processes.spawn(
      `node -e "require('http').createServer((q, s) => s.end('agent37 ok')).listen(8080)"`,
    );
    try {
      const url = await sandbox.networking.getPortUrl(8080);
      expect(url).toMatch(/^https:\/\/.*8080/);
      let body = '';
      for (let attempt = 0; attempt < 15 && body !== 'agent37 ok'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        body = await fetch(url!).then(r => r.text()).catch(() => '');
      }
      expect(body).toBe('agent37 ok');
    } finally {
      await server.kill();
    }
  });

  it('works as a Mastra Workspace sandbox', async () => {
    const workspace = new Workspace({ sandbox, filesystem: sandbox.filesystem });
    await workspace.init();
    await workspace.filesystem!.writeFile('/tmp/ws.txt', 'from workspace');
    const result = await workspace.sandbox!.executeCommand!('cat /tmp/ws.txt');
    expect(result.stdout).toBe('from workspace');
  });

  it('sleeps on stop, keeps background processes, and reconnects by id from a new object', async () => {
    const ticker = await sandbox.processes.spawn('i=0; while true; do i=$((i+1)); echo $i > /tmp/tick; sleep 1; done');
    await new Promise(resolve => setTimeout(resolve, 2500));
    const before = Number((await sandbox.executeCommand!('cat /tmp/tick')).stdout);
    await sandbox._stop();
    expect(sandbox.status).toBe('stopped');
    expect((await new Agent37Client().getInstance(sandbox.instanceId!)).status).toBe('sleeping');

    const again = new Agent37Sandbox({ id: sandbox.id });
    await again._start();
    expect(again.instanceId).toBe(sandbox.instanceId);
    await new Promise(resolve => setTimeout(resolve, 2500));
    const after = Number((await again.executeCommand!('cat /tmp/tick')).stdout);
    expect(after).toBeGreaterThan(before);
    await again.executeCommand!(`kill -9 -${ticker.pid} 2>/dev/null; true`);
    sandbox = again;
    created.push(again);
  }, 180_000);

  it("halts on stop with stopMode 'stop' and keeps files across the restart", async () => {
    const halting = new Agent37Sandbox({ id: sandbox.id, stopMode: 'stop' });
    created.push(halting);
    await halting._start();
    await halting.filesystem.writeFile('/home/node/persist.txt', 'kept');
    await halting._stop();
    expect((await new Agent37Client().getInstance(halting.instanceId!)).status).toBe('stopped');
    await halting._start();
    expect(await halting.filesystem.readFile('/home/node/persist.txt', { encoding: 'utf-8' })).toBe('kept');
  }, 180_000);

  it('deletes the instance on destroy', async () => {
    const id = sandbox.instanceId!;
    await sandbox._destroy();
    expect(sandbox.status).toBe('destroyed');
    const remaining = await new Agent37Client().listInstances();
    expect(remaining.some(instance => instance.id === id)).toBe(false);
  }, 120_000);
});

describe.skipIf(!hasKey)('Agent37Computer (live, agent37-ubuntu)', () => {
  let sandbox: Agent37Sandbox;

  beforeAll(async () => {
    sandbox = testSandbox('desktop', { computer: true });
    await sandbox._start();
  }, 300_000);

  it('drives the desktop: screenshot, open an app, click, type, screenshot again', async () => {
    const computer = sandbox.computer!;
    const size = await computer.getScreenSize();
    expect(size.width).toBeGreaterThan(0);
    const first = await computer.screenshot();
    expect(first.mediaType).toBe('image/png');
    expect(Buffer.from(first.data).readUInt32BE(0)).toBe(0x89504e47);

    await sandbox.runScript(
      "rm -f /tmp/computer-proof.txt; su ubuntu -c 'DISPLAY=:1 setsid xfce4-terminal --geometry 80x20+200+150 >/dev/null 2>&1 &'",
      { user: 'root' },
    );
    await new Promise(resolve => setTimeout(resolve, 4000));
    await computer.leftClick(450, 300);
    await computer.type('echo mastra-agent37-ok > /tmp/computer-proof.txt');
    await computer.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const proof = await sandbox.executeCommand!('cat /tmp/computer-proof.txt');
    expect(proof.stdout.trim()).toBe('mastra-agent37-ok');

    await computer.moveMouse(700, 500);
    expect(await computer.getCursorPosition()).toEqual({ x: 700, y: 500 });
    const second = await computer.screenshot();
    expect(Buffer.from(second.data).equals(Buffer.from(first.data))).toBe(false);

    const stream = await computer.streamUrl();
    expect(stream).toMatch(/\/vnc\.html\?/);
    expect((await fetch(stream!)).status).toBe(200);
  }, 300_000);
});
