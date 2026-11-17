/**
 * An in-memory fake of the Agent37 Cloud API for unit tests, served through
 * the client's `fetch` option. Instances live in a Map; exec runs the script
 * in a local `sh` (so process and filesystem scripts are tested for real)
 * unless a test installs its own exec handler.
 */

import { execFile } from 'node:child_process';

import type { Agent37ExecParams, Agent37ExecResult, Agent37Instance } from '../client/types';

export type ExecHandler = (
  instanceId: string,
  params: Agent37ExecParams,
) => Agent37ExecResult | { pid: number } | Promise<Agent37ExecResult | { pid: number }>;

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  body?: any;
  headers: Record<string, string>;
}

interface InjectedFailure {
  match: (call: RecordedCall) => boolean;
  status: number;
  error: unknown;
  times: number;
}

/** Run a script in the local shell, like Agent37's exec (`sh -c`). */
export function localExec(params: Agent37ExecParams): Promise<Agent37ExecResult> {
  return new Promise(resolve => {
    execFile('sh', ['-c', params.command], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ exit_code: code, stdout, stderr, truncated: false });
    });
  });
}

let idCounter = 0;
const newId = () => ('fk' + (++idCounter).toString(36).padStart(8, '0')).slice(0, 10);

export class FakeAgent37 {
  readonly instances = new Map<string, Agent37Instance>();
  readonly calls: RecordedCall[] = [];
  readonly execNames = new Map<string, Promise<unknown>>();
  execHandler: ExecHandler = (_id, params) => localExec(params);
  /** Status a new instance gets from create. */
  createStatus: Agent37Instance['status'] = 'running';
  private failures: InjectedFailure[] = [];

  /** Add an instance directly (as if created earlier, possibly by another process). */
  seed(instance: Partial<Agent37Instance> = {}): Agent37Instance {
    const id = instance.id ?? newId();
    const full: Agent37Instance = {
      id,
      status: 'running',
      template: 'agent37-base',
      type: 'default',
      region: 'us',
      mount_path: '/home/node',
      resources: { cpu: 2, memory: 4, disk: 4 },
      url: `https://${id}.agent37.app`,
      public_ports: [],
      name: null,
      metadata: null,
      auto_sleep: false,
      idle_timeout_seconds: 900,
      network: 'allow-all',
      created: 1_790_000_000,
      ...instance,
    };
    this.instances.set(id, full);
    return full;
  }

  /** Make the next `times` matching calls fail with an Agent37 error body. */
  fail(match: (call: RecordedCall) => boolean, status: number, error: unknown, times = 1): void {
    this.failures.push({ match, status, error, times });
  }

  callsTo(method: string, pathPattern: RegExp): RecordedCall[] {
    return this.calls.filter(call => call.method === method && pathPattern.test(call.path));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = parsed.pathname.replace(/^\/v1/, '');
    const call: RecordedCall = { method, url, path, body, headers };
    this.calls.push(call);

    const failure = this.failures.find(f => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return json(failure.status, { error: failure.error });
    }
    return this.route(method, path, body);
  };

  private async route(method: string, path: string, body: any): Promise<Response> {
    if (method === 'GET' && path === '/instances') {
      return json(200, { data: [...this.instances.values()].reverse() });
    }
    if (method === 'POST' && path === '/instances') {
      const instance = this.seed({
        status: this.createStatus,
        template: body?.template ?? 'agent37-base',
        type: body?.type ?? 'default',
        name: body?.name ?? null,
        metadata: body?.metadata ?? null,
        auto_sleep: body?.auto_sleep ?? false,
        idle_timeout_seconds: body?.idle_timeout_seconds ?? 900,
        ...(body?.resources && { resources: body.resources }),
        ...(body?.region && { region: body.region }),
        ...(body?.network && { network: body.network }),
      });
      return json(201, instance);
    }
    const match = /^\/instances\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match) return json(404, { error: { code: 'not_found', message: 'Unknown path' } });
    const [, id, action] = match;
    const instance = this.instances.get(id!);
    if (!instance || instance.status === 'deleted') {
      return json(404, action === 'exec' ? { error: 'not_found' } : { error: { code: 'not_found', message: 'No such instance' } });
    }

    switch (`${method} ${action ?? ''}`) {
      case 'GET ':
        return json(200, instance);
      case 'PATCH ':
        Object.assign(instance, body);
        return json(200, instance);
      case 'DELETE ':
        this.instances.delete(id!);
        return json(200, { id, deleted: true });
      case 'POST stop':
        instance.status = 'stopped';
        return json(200, { id, status: 'stopped' });
      case 'POST start':
        instance.status = 'running';
        return json(200, { id, status: 'running' });
      case 'POST sleep':
        if (instance.status !== 'running') {
          return json(400, { error: { code: 'invalid_request', message: 'Instance is not running' } });
        }
        instance.status = 'sleeping';
        return json(200, { id, status: 'sleeping' });
      case 'POST restart':
        return json(200, { id, status: 'running' });
      case 'POST backups':
        return json(201, { id: 'bk1', kind: 'manual', created: 1_790_000_100, size_bytes: 1 });
      case 'GET backups':
        return json(200, { data: [{ id: 'bk1', kind: 'manual', created: 1_790_000_100 }] });
      case 'POST signed-url':
        return json(200, {
          url: `https://${id}-${body.port}.agent37.app/?a37_token=tok123`,
          domain_urls: [],
          port: body.port,
          expires_at: 1_790_003_600,
        });
      case 'POST exec': {
        if (instance.status === 'sleeping') instance.status = 'running';
        if (instance.status !== 'running') {
          return json(400, { error: { code: 'invalid_request', message: `Instance is ${instance.status}` } });
        }
        const run = () => Promise.resolve(this.execHandler(id!, body));
        let promise: Promise<unknown>;
        if (body.name) {
          promise = this.execNames.get(body.name) ?? run();
          this.execNames.set(body.name, promise);
        } else {
          promise = run();
        }
        return json(200, await promise);
      }
      default:
        return json(404, { error: { code: 'not_found', message: 'Unknown path' } });
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
