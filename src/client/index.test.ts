import { describe, expect, it, vi } from 'vitest';

import { FakeAgent37 } from '../test-utils/fake-agent37';
import { Agent37ApiError, Agent37Client } from './index';

function makeClient(fake = new FakeAgent37(), options: { maxRetries?: number } = {}) {
  return {
    fake,
    client: new Agent37Client({ apiKey: 'sk_test_key', fetch: fake.fetch, retryBaseDelayMs: 1, ...options }),
  };
}

describe('Agent37Client', () => {
  it('throws a helpful error when no API key is configured', () => {
    const saved = process.env.AGENT37_API_KEY;
    delete process.env.AGENT37_API_KEY;
    try {
      expect(() => new Agent37Client()).toThrow(/AGENT37_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.AGENT37_API_KEY = saved;
    }
  });

  it('reads the key from AGENT37_API_KEY', async () => {
    const fake = new FakeAgent37();
    vi.stubEnv('AGENT37_API_KEY', 'sk_from_env');
    try {
      await new Agent37Client({ fetch: fake.fetch }).listInstances();
      expect(fake.calls[0]!.headers.Authorization).toBe('Bearer sk_from_env');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends Bearer auth to the Sandbox API and X-Agent37-Key to exec', async () => {
    const { fake, client } = makeClient();
    const instance = fake.seed();
    fake.execHandler = () => ({ exit_code: 0, stdout: 'ok', stderr: '', truncated: false });
    await client.getInstance(instance.id);
    await client.exec(instance.id, { command: 'true' });
    const [get, exec] = fake.calls;
    expect(get!.url).toBe(`https://api.agent37.com/v1/instances/${instance.id}`);
    expect(get!.headers.Authorization).toBe('Bearer sk_test_key');
    expect(get!.headers['X-Agent37-Key']).toBeUndefined();
    expect(exec!.url).toBe(`https://sandbox.agent37.app/v1/instances/${instance.id}/exec`);
    expect(exec!.headers['X-Agent37-Key']).toBe('sk_test_key');
    expect(exec!.headers.Authorization).toBeUndefined();
  });

  it('honors custom base URLs', async () => {
    const fake = new FakeAgent37();
    const client = new Agent37Client({
      apiKey: 'k',
      fetch: fake.fetch,
      apiUrl: 'https://api.example.com/v1/',
      execUrl: 'https://sandbox.example.com/',
    });
    await client.listInstances();
    expect(fake.calls[0]!.url).toBe('https://api.example.com/v1/instances');
  });

  it('parses the Sandbox API error envelope', async () => {
    const { client } = makeClient();
    const error = await client.getInstance('missing').catch(e => e);
    expect(error).toBeInstanceOf(Agent37ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.isNotFound).toBe(true);
    expect(error.message).toContain('No such instance');
  });

  it('parses flat transport errors from the exec plane', async () => {
    const { client } = makeClient();
    const error = await client.exec('missing', { command: 'true' }).catch(e => e);
    expect(error.code).toBe('not_found');
    expect(error.isNotFound).toBe(true);
  });

  it('keeps raw text bodies and detail fields', async () => {
    const fetchImpl = vi.fn(async () => new Response('gateway exploded', { status: 500 }));
    const client = new Agent37Client({ apiKey: 'k', fetch: fetchImpl as typeof fetch, maxRetries: 0 });
    const error = await client.listInstances().catch(e => e);
    expect(error.code).toBe('http_500');
    expect(error.message).toContain('gateway exploded');

    const detailFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'provisioning_failed', message: 'boom', detail: 'tail of log' } }),
          {
            status: 502,
          },
        ),
    );
    const detailed = await new Agent37Client({ apiKey: 'k', fetch: detailFetch as typeof fetch })
      .createInstance()
      .catch(e => e);
    expect(detailed.detail).toBe('tail of log');
    expect(detailFetch).toHaveBeenCalledTimes(1);
  });

  it('never includes the API key in error messages', async () => {
    const { client } = makeClient();
    const error = await client.getInstance('missing').catch(e => e);
    expect(String(error.message)).not.toContain('sk_test_key');
  });

  it('retries documented transient errors on idempotent calls', async () => {
    const { fake, client } = makeClient();
    const instance = fake.seed();
    fake.fail(
      c => c.method === 'POST' && c.path.endsWith('/start'),
      409,
      { code: 'try_again', message: 'checkpointing' },
      2,
    );
    const ack = await client.startInstance(instance.id);
    expect(ack.status).toBe('running');
    expect(fake.callsTo('POST', /\/start$/)).toHaveLength(3);
  });

  it('honors Retry-After on rate limits', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), {
          status: 429,
          headers: { 'retry-after': '0.01' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const client = new Agent37Client({ apiKey: 'k', fetch: fetchImpl as typeof fetch, retryBaseDelayMs: 1 });
    expect(await client.listBackups('abc')).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries', async () => {
    const { fake, client } = makeClient(new FakeAgent37(), { maxRetries: 1 });
    fake.fail(c => c.path === '/instances', 503, { code: 'try_again', message: 'busy' }, 5);
    await expect(client.listInstances()).rejects.toMatchObject({ code: 'try_again' });
    expect(fake.calls).toHaveLength(2);
  });

  it('does not retry create (a retry could create a duplicate)', async () => {
    const { fake, client } = makeClient();
    fake.fail(c => c.method === 'POST' && c.path === '/instances', 503, { code: 'no_capacity', message: 'full' });
    await expect(client.createInstance()).rejects.toMatchObject({ code: 'no_capacity' });
    expect(fake.calls).toHaveLength(1);
  });

  it('retries exec only when it carries an idempotency name', async () => {
    const { fake, client } = makeClient();
    const instance = fake.seed();
    fake.execHandler = () => ({ exit_code: 0, stdout: 'done', stderr: '', truncated: false });
    fake.fail(c => c.path.endsWith('/exec'), 503, 'wake_failed', 1);
    await expect(client.exec(instance.id, { command: 'x' })).rejects.toMatchObject({ code: 'wake_failed' });

    fake.fail(c => c.path.endsWith('/exec'), 503, 'wake_timeout', 1);
    const result = await client.exec(instance.id, { command: 'x', name: 'run-1' });
    expect(result.stdout).toBe('done');
  });

  it('retries network errors on idempotent calls', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const client = new Agent37Client({ apiKey: 'k', fetch: fetchImpl as typeof fetch, retryBaseDelayMs: 1 });
    expect(await client.listInstances()).toEqual([]);
  });

  it('does not retry when the caller aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const client = new Agent37Client({ apiKey: 'k', fetch: fetchImpl as typeof fetch, retryBaseDelayMs: 1 });
    await expect(client.listInstances(controller.signal)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('covers the instance lifecycle endpoints', async () => {
    const { fake, client } = makeClient();
    const created = await client.createInstance({ template: 'agent37-base', metadata: { a: 'b' } });
    expect(created.status).toBe('running');
    expect((await client.listInstances()).map(i => i.id)).toEqual([created.id]);
    expect((await client.updateInstance(created.id, { name: 'renamed' })).name).toBe('renamed');
    expect((await client.sleepInstance(created.id)).status).toBe('sleeping');
    expect((await client.startInstance(created.id)).status).toBe('running');
    expect((await client.stopInstance(created.id)).status).toBe('stopped');
    expect((await client.restartInstance(created.id)).status).toBe('running');
    expect((await client.createBackup(created.id)).kind).toBe('manual');
    expect(await client.listBackups(created.id)).toHaveLength(1);
    const signed = await client.createSignedUrl(created.id, 6080, 60);
    expect(signed.url).toContain(`${created.id}-6080.agent37.app`);
    expect(fake.callsTo('POST', /signed-url$/)[0]!.body).toEqual({ port: 6080, ttl_seconds: 60 });
    expect(client.previewUrl(created.id, 3000)).toBe(`https://${created.id}-3000.agent37.app`);
    expect(await client.deleteInstance(created.id)).toBe(true);
    expect(await client.deleteInstance(created.id)).toBe(false);
  });

  it('rethrows non-404 delete failures', async () => {
    const { fake, client } = makeClient(new FakeAgent37(), { maxRetries: 0 });
    const instance = fake.seed();
    fake.fail(c => c.method === 'DELETE', 403, { code: 'forbidden', message: 'no' });
    await expect(client.deleteInstance(instance.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
