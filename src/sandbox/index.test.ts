import { Workspace } from '@mastra/core/workspace';
import { supportsComputer } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';

import { Agent37Client } from '../client';
import { FakeAgent37 } from '../test-utils/fake-agent37';
import { Agent37Sandbox, SANDBOX_ID_METADATA_KEY } from './index';
import type { Agent37SandboxOptions } from './index';

function setup(options: Agent37SandboxOptions = {}, fake = new FakeAgent37()) {
  const client = new Agent37Client({ apiKey: 'sk_test', fetch: fake.fetch, retryBaseDelayMs: 1 });
  fake.execHandler = () => ({ exit_code: 0, stdout: '', stderr: '', truncated: false });
  const sandbox = new Agent37Sandbox({ client, ...options });
  return { fake, sandbox, client };
}

describe('Agent37Sandbox', () => {
  describe('construction', () => {
    it('reports its identity and generates an id', () => {
      const { sandbox } = setup();
      expect(sandbox.name).toBe('Agent37Sandbox');
      expect(sandbox.provider).toBe('agent37');
      expect(sandbox.status).toBe('pending');
      expect(sandbox.id).toMatch(/^agent37-sandbox-/);
      expect(sandbox.instanceId).toBeUndefined();
      expect(() => sandbox.instance).toThrow();
    });

    it('exposes processes, filesystem, and networking, but computer only when enabled', () => {
      const { sandbox } = setup();
      expect(sandbox.processes).toBeDefined();
      expect(sandbox.filesystem.provider).toBe('agent37');
      expect(typeof sandbox.networking.getPortUrl).toBe('function');
      expect(sandbox.computer).toBeUndefined();
      expect(supportsComputer(sandbox)).toBe(false);
      const { sandbox: desktop } = setup({ computer: true });
      expect(supportsComputer(desktop)).toBe(true);
    });

    it('builds its client from apiKey/fetch options', async () => {
      const fake = new FakeAgent37();
      const sandbox = new Agent37Sandbox({ apiKey: 'sk_opt', fetch: fake.fetch, id: 'x' });
      await sandbox.start();
      expect(fake.calls[0]!.headers.Authorization).toBe('Bearer sk_opt');
    });
  });

  describe('start: get-or-create', () => {
    it('creates a tagged instance with default parameters', async () => {
      const { fake, sandbox } = setup({ id: 'proj-1' });
      expect(await sandbox.start()).toEqual({ outcome: 'created' });
      expect(sandbox.status).toBe('running');
      const [create] = fake.callsTo('POST', /^\/instances$/);
      expect(create!.body).toEqual({
        template: 'agent37-base',
        name: 'mastra-proj-1',
        metadata: { [SANDBOX_ID_METADATA_KEY]: 'proj-1', mastra_provider: 'agent37' },
        auto_sleep: true,
        idle_timeout_seconds: 900,
      });
      expect(sandbox.instanceId).toBe(sandbox.instance.id);
    });

    it('uses the agent37-ubuntu VM template when computer use is enabled', async () => {
      const { fake, sandbox } = setup({ computer: true });
      await sandbox.start();
      expect(fake.callsTo('POST', /^\/instances$/)[0]!.body).toMatchObject({ template: 'agent37-ubuntu', type: 'vm' });
    });

    it('passes every create option through', async () => {
      const { fake, sandbox } = setup({
        id: 'p',
        template: 'agent37-ubuntu@2026.10.01',
        region: 'eu',
        resources: { cpu: 4, memory: 8, disk: 20 },
        instanceName: 'n'.repeat(80),
        metadata: { team: 'core' },
        instanceEnv: { APP_ENV: 'test' },
        autoSleep: false,
        idleTimeoutSeconds: 600,
        network: { allow: ['github.com'] },
        createParams: { budget: { credit_micros: 1 }, mount_path: '/data' },
      });
      await sandbox.start();
      const body = fake.callsTo('POST', /^\/instances$/)[0]!.body;
      expect(body).toMatchObject({
        template: 'agent37-ubuntu@2026.10.01',
        type: 'vm',
        region: 'eu',
        resources: { cpu: 4, memory: 8, disk: 20 },
        metadata: { team: 'core', [SANDBOX_ID_METADATA_KEY]: 'p', mastra_provider: 'agent37' },
        env: { APP_ENV: 'test' },
        auto_sleep: false,
        idle_timeout_seconds: 600,
        network: { allow: ['github.com'] },
        budget: { credit_micros: 1 },
        mount_path: '/data',
      });
      expect(body.name).toHaveLength(60);
    });

    it('reconnects to an instance tagged with the same logical id', async () => {
      const { fake, sandbox } = setup({ id: 'shared' });
      const existing = fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'shared' } });
      fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'other' } });
      expect(await sandbox.start()).toEqual({ outcome: 'connected' });
      expect(sandbox.instanceId).toBe(existing.id);
      expect(fake.callsTo('POST', /^\/instances$/)).toHaveLength(0);
    });

    it('wakes a sleeping instance and starts a stopped one', async () => {
      for (const status of ['sleeping', 'stopped'] as const) {
        const { fake, sandbox } = setup({ id: 'w' });
        const existing = fake.seed({ status, metadata: { [SANDBOX_ID_METADATA_KEY]: 'w' } });
        expect(await sandbox.start()).toEqual({ outcome: 'connected' });
        expect(fake.callsTo('POST', /\/start$/)).toHaveLength(1);
        expect(fake.instances.get(existing.id)!.status).toBe('running');
      }
    });

    it('waits for an instance in a transitional state', async () => {
      const { fake, sandbox } = setup({ id: 't' });
      const existing = fake.seed({ status: 'starting', metadata: { [SANDBOX_ID_METADATA_KEY]: 't' } });
      setTimeout(() => (fake.instances.get(existing.id)!.status = 'running'), 500);
      expect(await sandbox.start()).toEqual({ outcome: 'connected' });
      expect(fake.callsTo('POST', /\/start$/)).toHaveLength(0);
    }, 15_000);

    it('replaces a failed instance with a fresh one', async () => {
      const { fake, sandbox } = setup({ id: 'f' });
      const failed = fake.seed({ status: 'failed', metadata: { [SANDBOX_ID_METADATA_KEY]: 'f' } });
      expect(await sandbox.start()).toEqual({ outcome: 'created' });
      expect(fake.instances.has(failed.id)).toBe(false);
      expect(sandbox.instanceId).not.toBe(failed.id);
    });

    it('adopts an explicit instanceId', async () => {
      const { fake, sandbox } = setup({ instanceId: 'abcdefghij' });
      fake.seed({ id: 'abcdefghij', status: 'sleeping' });
      expect(await sandbox.start()).toEqual({ outcome: 'connected' });
      expect(sandbox.instanceId).toBe('abcdefghij');
    });

    it('fails instead of creating when an explicit instanceId does not exist', async () => {
      const { fake, sandbox } = setup({ instanceId: 'missing123' });
      await expect(sandbox.start()).rejects.toThrow(/missing123 was not found/);
      expect(fake.callsTo('POST', /^\/instances$/)).toHaveLength(0);
      expect(sandbox.status).toBe('error');
    });

    it('propagates lookup errors instead of creating a duplicate', async () => {
      const { fake, sandbox } = setup();
      fake.fail(c => c.path === '/instances' && c.method === 'GET', 401, {
        code: 'invalid_api_key',
        message: 'bad key',
      });
      await expect(sandbox.start()).rejects.toMatchObject({ code: 'invalid_api_key' });
      expect(fake.callsTo('POST', /^\/instances$/)).toHaveLength(0);
    });

    it('waits for a created instance that is still provisioning', async () => {
      const fake = new FakeAgent37();
      fake.createStatus = 'provisioning';
      const { sandbox } = setup({}, fake);
      const started = sandbox.start();
      setTimeout(() => {
        for (const instance of fake.instances.values()) instance.status = 'running';
      }, 300);
      expect(await started).toEqual({ outcome: 'created' });
    }, 15_000);

    it('surfaces a failed provisioning with its reason', async () => {
      const fake = new FakeAgent37();
      fake.createStatus = 'provisioning';
      const { sandbox } = setup({}, fake);
      setTimeout(() => {
        for (const instance of fake.instances.values()) {
          instance.status = 'failed';
          instance.status_reason = { code: 'provisioning_failed', message: 'image pull failed' };
        }
      }, 300);
      await expect(sandbox.start()).rejects.toThrow(/image pull failed/);
    }, 15_000);

    it('adopts the instance a lost create response produced', async () => {
      const fake = new FakeAgent37();
      const { sandbox } = setup({ id: 'lost' }, fake);
      const original = fake.fetch;
      let dropped = false;
      (fake as { fetch: typeof fetch }).fetch = original;
      const client = new Agent37Client({
        apiKey: 'k',
        retryBaseDelayMs: 1,
        fetch: async (input, init) => {
          const response = await original(input, init);
          if (!dropped && init?.method === 'POST' && String(input).endsWith('/v1/instances')) {
            dropped = true;
            throw new TypeError('fetch failed');
          }
          return response;
        },
      });
      const lossy = new Agent37Sandbox({ client, id: 'lost' });
      expect(await lossy.start()).toEqual({ outcome: 'created' });
      expect(fake.instances.size).toBe(1);
      expect(lossy.instanceId).toBe([...fake.instances.keys()][0]);
      void sandbox;
    });

    it('runs onStart with the outcome', async () => {
      const onStart = vi.fn();
      const { fake } = setup();
      fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'hooked' } });
      const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch, retryBaseDelayMs: 1 });
      const sandbox = new Agent37Sandbox({ client, id: 'hooked', onStart });
      await sandbox.start();
      expect(onStart).toHaveBeenCalledWith({ sandbox, outcome: 'connected' });
    });
  });

  describe('stop and destroy', () => {
    it('sleeps the instance by default', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      const id = sandbox.instanceId!;
      await sandbox._stop();
      expect(sandbox.status).toBe('stopped');
      expect(fake.instances.get(id)!.status).toBe('sleeping');
      expect(await sandbox.start()).toEqual({ outcome: 'connected' });
      expect(sandbox.instanceId).toBe(id);
    });

    it("halts the instance with stopMode 'stop'", async () => {
      const { fake, sandbox } = setup({ stopMode: 'stop' });
      await sandbox.start();
      const id = sandbox.instanceId!;
      await sandbox.stop();
      expect(fake.instances.get(id)!.status).toBe('stopped');
    });

    it('tolerates stopping an instance that is already down or gone', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      fake.instances.get(sandbox.instanceId!)!.status = 'stopped';
      await expect(sandbox.stop()).resolves.toBeUndefined();
      const { fake: fake2, sandbox: gone } = setup();
      await gone.start();
      fake2.instances.clear();
      await expect(gone.stop()).resolves.toBeUndefined();
    });

    it('rethrows unexpected stop failures', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      fake.fail(c => c.path.endsWith('/sleep'), 403, { code: 'forbidden', message: 'nope' });
      await expect(sandbox._stop()).rejects.toMatchObject({ code: 'forbidden' });
      expect(sandbox.status).toBe('error');
    });

    it('stops an instance this process never attached to', async () => {
      const { fake, sandbox } = setup({ id: 'detached' });
      const existing = fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'detached' } });
      sandbox.status = 'running';
      await sandbox._stop();
      expect(fake.instances.get(existing.id)!.status).toBe('sleeping');
    });

    it('deletes the instance on destroy', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      await sandbox._destroy();
      expect(fake.instances.size).toBe(0);
      expect(sandbox.status).toBe('destroyed');
      expect(sandbox.instanceId).toBeUndefined();
    });

    it('destroys a detached instance found by its tag', async () => {
      const { fake, sandbox } = setup({ id: 'orphan' });
      fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'orphan' } });
      sandbox.status = 'stopped';
      await sandbox._destroy();
      expect(fake.instances.size).toBe(0);
    });

    it('treats an already deleted instance as destroyed', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      fake.instances.clear();
      await sandbox._destroy();
      expect(sandbox.status).toBe('destroyed');
    });
  });

  describe('recovery', () => {
    it('recreates the instance when it was deleted elsewhere', async () => {
      const { fake, sandbox } = setup({ id: 'r' });
      await sandbox.start();
      const first = sandbox.instanceId;
      fake.instances.clear();
      fake.execHandler = () => ({ exit_code: 0, stdout: 'again', stderr: '', truncated: false });
      const result = await sandbox.runScript('echo again');
      expect(result.stdout).toBe('again');
      expect(sandbox.instanceId).not.toBe(first);
      expect(fake.instances.size).toBe(1);
    });

    it('restarts an instance that was stopped elsewhere', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      const id = sandbox.instanceId!;
      fake.instances.get(id)!.status = 'stopped';
      fake.execHandler = () => ({ exit_code: 0, stdout: 'up', stderr: '', truncated: false });
      expect((await sandbox.runScript('true')).stdout).toBe('up');
      expect(sandbox.instanceId).toBe(id);
      expect(fake.callsTo('POST', /\/start$/)).toHaveLength(1);
    });

    it('does not retry other exec errors', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      fake.fail(c => c.path.endsWith('/exec'), 413, { code: 'invalid_request', message: 'too big' });
      await expect(sandbox.runScript('x')).rejects.toMatchObject({ status: 413 });
    });

    it('can skip recovery for a single call', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      fake.instances.clear();
      await expect(sandbox.runScript('x', { retryOnDead: false })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('runs scripts as root on request, or as the configured user', async () => {
      const { fake, sandbox } = setup({ user: 'root' });
      await sandbox.runScript('id');
      expect(fake.callsTo('POST', /exec$/)[0]!.body).toEqual({ command: 'id', user: 'root' });
      const { fake: fake2, sandbox: plain } = setup();
      await plain.runScript('id', { name: 'n1' });
      await plain.runScript('id', { user: 'root' });
      expect(fake2.callsTo('POST', /exec$/).map(c => c.body)).toEqual([
        { command: 'id', name: 'n1' },
        { command: 'id', user: 'root' },
      ]);
    });
  });

  describe('networking, snapshots, info', () => {
    it('returns a public port URL when one is configured, else a signed URL', async () => {
      const { fake, sandbox } = setup();
      await sandbox.start();
      const instance = fake.instances.get(sandbox.instanceId!)!;
      instance.public_ports = [{ port: 8080, url: 'https://pub.agent37.app' }];
      // The sandbox reads ports from the instance it adopted at start.
      sandbox.instance.public_ports = instance.public_ports;
      expect(await sandbox.networking.getPortUrl(8080)).toBe('https://pub.agent37.app');
      expect(await sandbox.networking.getPortUrl(3000)).toBe(
        `https://${instance.id}-3000.agent37.app/?a37_token=tok123`,
      );
      expect(fake.callsTo('POST', /signed-url$/)[0]!.body).toEqual({ port: 3000, ttl_seconds: 3600 });
      expect(sandbox.previewUrl(3000)).toBe(`https://${instance.id}-3000.agent37.app`);
      expect(await sandbox.signedUrl(3000, 60)).toContain('a37_token');
    });

    it('resolves port URLs without starting the sandbox, and null when unknown', async () => {
      const { fake, sandbox } = setup({ id: 'np' });
      expect(await sandbox.networking.getPortUrl(80)).toBeNull();
      fake.seed({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'np' } });
      expect(await sandbox.networking.getPortUrl(80)).toContain('-80.agent37.app');
      expect(sandbox.status).toBe('pending');
    });

    it('takes a backup on snapshot()', async () => {
      const { fake, sandbox } = setup();
      await sandbox.snapshot();
      expect(fake.callsTo('POST', /\/backups$/)).toHaveLength(1);
    });

    it('reports info and instructions', async () => {
      const { sandbox } = setup({ computer: true, workingDirectory: '/home/node/app' });
      expect((await sandbox.getInfo()).metadata).toMatchObject({ template: 'agent37-ubuntu', computer: true });
      await sandbox.start();
      const info = await sandbox.getInfo();
      expect(info).toMatchObject({
        id: sandbox.id,
        provider: 'agent37',
        status: 'running',
        resources: { cpuCores: 2, memoryMB: 4096, diskMB: 4096 },
        metadata: { instanceId: sandbox.instanceId, instanceStatus: 'running', mountPath: '/home/node' },
      });
      const instructions = sandbox.getInstructions();
      expect(instructions).toContain('Agent37 Cloud');
      expect(instructions).toContain('/home/node/app');
      expect(instructions).toContain('desktop');
    });

    it('clones its configuration without I/O', () => {
      const { fake, sandbox } = setup({ id: 'a', template: 'my-tpl', instanceId: 'zzzzzzzzzz' });
      const clone = sandbox.clone({ id: 'b', env: { X: '1' }, idleTimeoutMinutes: 1, sandboxId: 'yyyyyyyyyy' });
      expect(clone).toBeInstanceOf(Agent37Sandbox);
      expect(clone.id).toBe('b');
      expect(clone.instanceId).toBe('yyyyyyyyyy');
      expect(clone.getEnv()).toEqual({ X: '1' });
      expect(fake.calls).toHaveLength(0);
      expect(sandbox.clone().instanceId).toBeUndefined();
    });

    it('works inside a Workspace', async () => {
      const { sandbox } = setup();
      const workspace = new Workspace({ sandbox });
      await workspace.init();
      expect(sandbox.status).toBe('running');
      await workspace.destroy();
      expect(sandbox.status).toBe('destroyed');
    });
  });

  describe('writeFiles', () => {
    it('writes each file and applies its mode', async () => {
      const { fake, sandbox } = setup();
      const commands: string[] = [];
      fake.execHandler = (_id, params) => {
        commands.push(params.command);
        return { exit_code: 0, stdout: '', stderr: '', truncated: false };
      };
      await sandbox.writeFiles([
        { path: '/tmp/a.sh', content: 'echo hi', mode: 0o755 },
        { path: '/tmp/b.txt', content: Buffer.from('b') },
      ]);
      expect(commands.some(c => c.includes('chmod 755 "$f"'))).toBe(true);
      expect(commands.filter(c => c.includes('base64 -d'))).toHaveLength(2);
    });

    it('stops between files when aborted', async () => {
      const { sandbox } = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(
        sandbox.writeFiles([{ path: '/tmp/a', content: 'a' }], { abortSignal: controller.signal }),
      ).rejects.toThrow();
    });
  });
});
