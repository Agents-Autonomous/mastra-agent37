/**
 * Agent37 Sandbox Provider
 *
 * A Mastra workspace sandbox backed by an Agent37 Cloud instance: a
 * persistent Linux sandbox or a full Linux VM with a desktop. Supports
 * get-or-create by logical id, reconnect and wake of a sleeping or stopped
 * instance, command execution with streaming output, background processes
 * with stdin, a native filesystem built on exec, port URLs, backups, and
 * computer use on the agent37-ubuntu desktop.
 *
 * @see https://www.agent37.com/docs/agents-api/overview
 */

import type {
  CommandResult,
  ExecuteCommandOptions,
  MastraSandboxOptions,
  ProviderStatus,
  SandboxCloneOptions,
  SandboxFileInput,
  SandboxInfo,
  SandboxNetworking,
  SandboxStartOptions,
  WriteFilesOptions,
} from '@mastra/core/workspace';
import { MastraSandbox, SandboxError, SandboxNotReadyError } from '@mastra/core/workspace';

import { Agent37ApiError, Agent37Client } from '../client';
import type {
  Agent37CreateInstanceParams,
  Agent37ExecResult,
  Agent37Instance,
  Agent37InstanceStatus,
  Agent37InstanceType,
  Agent37NetworkPolicy,
  Agent37Region,
  Agent37Resources,
} from '../client';
import { Agent37Computer } from './computer';
import type { Agent37ComputerOptions } from './computer';
import { Agent37Filesystem } from './filesystem';
import { Agent37ProcessManager } from './process-manager';
import type { Agent37ProcessOptions } from './process-manager';

const LOG_PREFIX = '[@mastra/agent37]';

/** Metadata key that ties an Agent37 instance to a sandbox's logical id. */
export const SANDBOX_ID_METADATA_KEY = 'mastra_sandbox_id';
/** Metadata key marking instances this package created. */
export const PROVIDER_METADATA_KEY = 'mastra_provider';

/** Templates that only run as a VM. */
const VM_ONLY_TEMPLATES = new Set(['agent37-ubuntu', 'agent37-android']);
/** Statuses an instance passes through on its way to running. */
const TRANSITIONAL: Agent37InstanceStatus[] = ['provisioning', 'starting', 'restarting', 'updating', 'waking'];
/** Statuses that mean the instance is gone or going. */
const GONE: Agent37InstanceStatus[] = ['deleting', 'deleted'];

const DEFAULT_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// Options
// =============================================================================

/** Agent37 sandbox configuration. */
export interface Agent37SandboxOptions extends Omit<MastraSandboxOptions, 'processes'> {
  /**
   * Logical sandbox id. The instance created for it is tagged with this id in
   * its metadata, so a later start() with the same id (in any process)
   * reconnects to it instead of creating a new one. Default: a random id.
   */
  id?: string;
  /** Adopt an existing Agent37 instance by its 10-character id instead of looking it up by logical id. */
  instanceId?: string;
  /** Workspace API key. Default: the AGENT37_API_KEY environment variable. */
  apiKey?: string;
  /** Sandbox API base URL. Default: https://api.agent37.com/v1. */
  apiUrl?: string;
  /** Exec base URL. Default: https://sandbox.agent37.app. */
  execUrl?: string;
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
  /** A preconfigured client (shared across sandboxes, custom retries). When set, apiKey, apiUrl, execUrl, and fetch are ignored. */
  client?: Agent37Client;
  /**
   * Template to create the instance from. Default: agent37-ubuntu when
   * computer use is enabled, otherwise agent37-base. Pin a release with
   * '@version' (for example 'my-template@2').
   */
  template?: string;
  /** Instance type. Default: 'vm' for agent37-ubuntu and agent37-android, otherwise Agent37's default ('default'). */
  type?: Agent37InstanceType;
  /** Region: 'us', 'eu', or 'ap-south'. Default: Agent37's default ('us'). */
  region?: Agent37Region;
  /** Shape: { cpu, memory (GB), disk (GB) }. Default: the template's default shape. */
  resources?: Agent37Resources;
  /** Instance label shown in the dashboard. Default: 'mastra-' + id (truncated to 60 characters). */
  instanceName?: string;
  /** Extra metadata stored on the instance. The provider adds mastra_sandbox_id and mastra_provider. */
  metadata?: Record<string, string>;
  /**
   * Container environment variables, set at create and replayed on every
   * boot. Use the 'env' option for per-command runtime variables (which are
   * never written to the instance).
   */
  instanceEnv?: Record<string, string>;
  /** Let Agent37 checkpoint the instance to 'sleeping' (disk-only billing) when idle. Default: true. */
  autoSleep?: boolean;
  /** Idle seconds before auto-sleep, 300 to 86400. Default: 900. */
  idleTimeoutSeconds?: number;
  /** Outbound network policy. Default: Agent37's default ('allow-all'). */
  network?: Agent37NetworkPolicy;
  /** Any other create fields (budget, public_ports, mount_path, ...). Merged last into the create request. */
  createParams?: Partial<Agent37CreateInstanceParams>;
  /** Run commands as root. Default: the image's default user. */
  user?: 'root';
  /** Default command timeout in ms for executeCommand(). Default: 300000 (5 minutes). */
  timeout?: number;
  /**
   * What stop() does. 'sleep' checkpoints memory and running processes and
   * resumes them on the next start; 'stop' halts the container (processes
   * and memory are lost, files kept). Both bill disk only. Default: 'sleep'.
   */
  stopMode?: 'sleep' | 'stop';
  /** Lifetime in seconds of the signed URLs networking.getPortUrl() mints. Default: 3600. */
  portUrlTtlSeconds?: number;
  /**
   * Enable the computer-use capability (screenshot, mouse, keyboard). Needs an
   * instance with an X11 desktop: agent37-ubuntu is the default template when
   * this is set. Default: false.
   */
  computer?: boolean | Agent37ComputerOptions;
  /** Tuning for background process output collection. */
  processes?: Agent37ProcessOptions;
}

export interface RunScriptOptions {
  /** Run as root instead of the sandbox's configured user. */
  user?: 'root';
  /** Exec idempotency label: a resend after a dropped connection returns the first run's result. */
  name?: string;
  /** Reconnect (or recreate) once when the instance turns out to be gone or halted. Default: true. */
  retryOnDead?: boolean;
}

// =============================================================================
// Agent37 Sandbox
// =============================================================================

/**
 * Agent37 Cloud sandbox provider for Mastra workspaces.
 *
 * @example Basic usage
 * ```typescript
 * import { Agent } from '@mastra/core/agent';
 * import { Workspace } from '@mastra/core/workspace';
 * import { Agent37Sandbox } from '@mastra/agent37';
 *
 * const workspace = new Workspace({ sandbox: new Agent37Sandbox({ id: 'my-project' }) });
 * const agent = new Agent({ id: 'coder', name: 'Coder', model: 'anthropic/claude-sonnet-5-5', workspace });
 * ```
 *
 * @example Computer use
 * ```typescript
 * const sandbox = new Agent37Sandbox({ computer: true }); // agent37-ubuntu VM with XFCE
 * await sandbox.start();
 * const { data } = await sandbox.computer.screenshot();
 * ```
 */
// MastraSandbox always installs executeCommand when a process manager is present (as it is here), so the type says so.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface Agent37Sandbox {
  executeCommand(command: string, args?: string[], options?: ExecuteCommandOptions): Promise<CommandResult>;
}

export class Agent37Sandbox extends MastraSandbox<Agent37Instance> {
  readonly id: string;
  readonly name = 'Agent37Sandbox';
  readonly provider = 'agent37';
  status: ProviderStatus = 'pending';

  declare readonly processes: Agent37ProcessManager;
  /** The instance disk, read and written over exec. Pass it as a Workspace filesystem to get file tools. */
  readonly filesystem: Agent37Filesystem;
  /** Computer-use capability; present only when the 'computer' option is set. */
  declare readonly computer?: Agent37Computer;

  /** Public HTTPS URLs for ports: a configured public port's URL, or a signed URL. */
  readonly networking: SandboxNetworking = {
    getPortUrl: async (port: number): Promise<string | null> => {
      try {
        const instance = this._instance ?? (await this.lookupInstance());
        if (!instance) return null;
        const publicPort = instance.public_ports?.find(p => p.port === port);
        if (publicPort) return publicPort.url;
        const signed = await this.client.createSignedUrl(instance.id, port, this.portUrlTtlSeconds);
        return signed.url;
      } catch {
        return null;
      }
    },
  };

  private readonly _client: Agent37Client;
  private readonly _options: Agent37SandboxOptions;
  private readonly template: string;
  private readonly instanceType?: Agent37InstanceType;
  private readonly user?: 'root';
  private readonly stopMode: 'sleep' | 'stop';
  private readonly portUrlTtlSeconds: number;
  private readonly timeout: number;
  private _instance: Agent37Instance | null = null;
  private _instanceId?: string;
  private _createdAt: Date | null = null;
  private _isRetrying = false;

  constructor(options: Agent37SandboxOptions = {}) {
    const { processes: processOptions, ...rest } = options;
    super({ ...rest, name: 'Agent37Sandbox', processes: new Agent37ProcessManager(processOptions) });

    this.id = options.id ?? 'agent37-sandbox-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    this._options = { ...options };
    this._client =
      options.client ??
      new Agent37Client({
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        execUrl: options.execUrl,
        fetch: options.fetch,
      });
    this.template = options.template ?? (options.computer ? 'agent37-ubuntu' : 'agent37-base');
    this.instanceType = options.type ?? (VM_ONLY_TEMPLATES.has(this.template.split('@')[0]!) ? 'vm' : undefined);
    this.user = options.user;
    this.stopMode = options.stopMode ?? 'sleep';
    this.portUrlTtlSeconds = options.portUrlTtlSeconds ?? 3600;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.defaultCommandTimeout = this.timeout;
    this._instanceId = options.instanceId;
    this.filesystem = new Agent37Filesystem(this);
    if (options.computer) {
      (this as { computer?: Agent37Computer }).computer = new Agent37Computer(
        this,
        typeof options.computer === 'object' ? options.computer : {},
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** The REST client, for Agent37 APIs this provider does not wrap. */
  get client(): Agent37Client {
    return this._client;
  }

  /** The Agent37 instance id once known (after start(), or from the instanceId option). */
  get instanceId(): string | undefined {
    return this._instance?.id ?? this._instanceId;
  }

  /**
   * The Agent37 instance object as of the last lifecycle call.
   * @throws {SandboxNotReadyError} If the sandbox has not been started
   */
  get instance(): Agent37Instance {
    if (!this._instance) throw new SandboxNotReadyError(this.id);
    return this._instance;
  }

  /** The authenticated preview URL of a port. Requests need the X-Agent37-Key header; use signedUrl() for browsers. */
  previewUrl(port: number): string {
    return this._client.previewUrl(this.instance.id, port);
  }

  /** Mint a time-boxed, browser-openable URL for a port (default lifetime 3600s). */
  async signedUrl(port: number, ttlSeconds?: number): Promise<string> {
    const signed = await this._client.createSignedUrl(this.instance.id, port, ttlSeconds);
    return signed.url;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Acquisition primitive: find the instance for this sandbox without side
   * effects other than deleting a failed one. Looks up the instanceId option
   * (or the id from an earlier start), else the instance whose metadata
   * carries this sandbox's logical id. Lookup errors other than not-found
   * propagate: creating a duplicate on an auth or network error would be worse.
   */
  protected override async find(): Promise<Agent37Instance | undefined> {
    if (this._instanceId) {
      try {
        const instance = await this._client.getInstance(this._instanceId);
        if (!GONE.includes(instance.status)) return instance;
      } catch (error) {
        if (!(error instanceof Agent37ApiError && error.isNotFound)) throw error;
      }
      if (this._options.instanceId && this._instanceId === this._options.instanceId) {
        throw new SandboxError('Agent37 instance ' + this._instanceId + ' was not found', 'NOT_FOUND', {
          instanceId: this._instanceId,
        });
      }
      this._instanceId = undefined;
    }

    const instance = await this.lookupByMetadata();
    if (!instance) return undefined;
    if (instance.status === 'failed') {
      this.logger.debug(LOG_PREFIX + ' Instance ' + instance.id + ' for ' + this.id + ' failed; deleting and creating fresh');
      await this._client.deleteInstance(instance.id).catch(() => {});
      return undefined;
    }
    return instance;
  }

  /** Acquisition primitive: wake or start an existing instance and adopt it. */
  protected override async connect(existing: Agent37Instance, options?: SandboxStartOptions): Promise<void> {
    const instance = await this.bringUp(existing, options?.abortSignal);
    this.adopt(instance);
    this.logger.debug(LOG_PREFIX + ' Connected to instance ' + instance.id + ' for ' + this.id);
  }

  /** Acquisition primitive: create a fresh instance tagged with this sandbox's logical id. */
  protected override async create(options?: SandboxStartOptions): Promise<void> {
    const params = this.buildCreateParams();
    this.logger.debug(LOG_PREFIX + ' Creating instance for ' + this.id + ' from ' + this.template);
    let instance: Agent37Instance;
    try {
      instance = await this._client.createInstance(params, options?.abortSignal);
    } catch (error) {
      // A dropped connection can hide a create that succeeded: adopt it by its metadata tag instead of creating twice.
      if (error instanceof Agent37ApiError || options?.abortSignal?.aborted) throw error;
      const adopted = await this.waitForTaggedInstance();
      if (!adopted) throw error;
      instance = adopted;
    }
    if (instance.status !== 'running') instance = await this.bringUp(instance, options?.abortSignal);
    this.adopt(instance);
  }

  /** Sleep (default) or stop the instance. Best effort when the instance is already down. */
  async stop(): Promise<void> {
    const id = this._instance?.id ?? (await this.lookupInstance().catch(() => undefined))?.id;
    this._instance = null;
    this.computer?.reset();
    // A stop ends every process; a sleep checkpoints them and they resume on the next start.
    if (this.stopMode === 'stop') this.processes.abandonAll('the instance was stopped');
    if (!id) return;
    try {
      if (this.stopMode === 'stop') {
        await this._client.stopInstance(id);
      } else {
        await this._client.sleepInstance(id);
      }
    } catch (error) {
      // 404: already gone. 400: already stopped/sleeping, or in a state that can't sleep.
      if (error instanceof Agent37ApiError && (error.isNotFound || error.status === 400)) return;
      throw error;
    }
  }

  /** Delete the instance and end its billing. Files, memory, and backups are gone. */
  async destroy(): Promise<void> {
    const id = this._instance?.id ?? (await this.lookupInstance())?.id;
    if (id) await this._client.deleteInstance(id);
    this.processes.abandonAll('the sandbox was destroyed');
    this._instance = null;
    this._instanceId = undefined;
    this.computer?.reset();
  }

  /** Take an on-demand Agent37 backup (one per instance every 15 minutes). */
  override async snapshot(): Promise<void> {
    await this.ensureRunning();
    await this._client.createBackup(this.instance.id);
  }

  async getInfo(): Promise<SandboxInfo> {
    const instance = this._instance;
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this._createdAt ?? new Date(),
      ...(instance?.resources && {
        resources: {
          cpuCores: instance.resources.cpu,
          memoryMB: instance.resources.memory * 1024,
          ...(instance.resources.disk !== undefined && { diskMB: instance.resources.disk * 1024 }),
        },
      }),
      metadata: {
        template: instance?.template ?? this.template,
        ...(this.instanceId && { instanceId: this.instanceId }),
        ...(instance && {
          instanceStatus: instance.status,
          type: instance.type,
          region: instance.region,
          url: instance.url,
          mountPath: instance.mount_path,
          autoSleep: instance.auto_sleep,
        }),
        computer: Boolean(this.computer),
      },
    };
  }

  getInstructions(): string {
    const instance = this._instance;
    const isVm = (instance?.type ?? this.instanceType) === 'vm' || (instance?.type ?? this.instanceType) === 'performance';
    const parts = [
      'Agent37 Cloud ' + (isVm ? 'Linux VM' : 'Linux sandbox') + ' (template ' + (instance?.template ?? this.template) + ').',
      'Commands run through sh as ' + (this.user ?? "the image's default user") + '.',
    ];
    if (this.workingDirectory) parts.push('Default working directory: ' + this.workingDirectory + '.');
    if (instance?.mount_path) parts.push('Persistent disk: ' + instance.mount_path + ' (survives restarts and updates).');
    parts.push('Command timeout: ' + Math.ceil(this.timeout / 1000) + 's.');
    if (this.computer) parts.push('A Linux desktop (X11) is available through the computer tools.');
    if (instance?.network === 'deny-all') parts.push('Network access is blocked.');
    return parts.join(' ');
  }

  /** Construct a sibling sandbox with this one's configuration and per-instance overrides. Performs no I/O. */
  clone(options: SandboxCloneOptions = {}): Agent37Sandbox {
    const { id: _id, instanceId: _instanceId, ...base } = this._options;
    return new Agent37Sandbox({
      ...base,
      ...(options.id !== undefined && { id: options.id }),
      ...(options.sandboxId !== undefined && { instanceId: options.sandboxId }),
      ...(options.env !== undefined && { env: options.env }),
      ...(options.workingDirectory !== undefined && { workingDirectory: options.workingDirectory }),
      ...(options.idleTimeoutMinutes !== undefined && {
        autoSleep: true,
        idleTimeoutSeconds: Math.min(86400, Math.max(300, Math.round(options.idleTimeoutMinutes * 60))),
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /** Write files into the instance (creating parent directories), applying 'mode' with chmod. */
  async writeFiles(files: SandboxFileInput[], options?: WriteFilesOptions): Promise<void> {
    await this.ensureRunning();
    for (const file of files) {
      options?.abortSignal?.throwIfAborted();
      await this.filesystem.writeFile(file.path, file.content);
      if (file.mode !== undefined) await this.filesystem.chmod(file.path, file.mode);
    }
  }

  // ---------------------------------------------------------------------------
  // Exec
  // ---------------------------------------------------------------------------

  /**
   * Run a POSIX sh script on the instance with one exec call and return its
   * raw result (a nonzero exit code is not an error). Starts the sandbox if
   * needed. This is the primitive the process manager, filesystem, and
   * computer are built on, and an escape hatch for anything they don't wrap.
   */
  async runScript(script: string, options: RunScriptOptions = {}): Promise<Agent37ExecResult> {
    await this.ensureRunning();
    const call = () =>
      this._client.exec(this.instance.id, {
        command: script,
        ...((options.user ?? this.user) && { user: options.user ?? this.user }),
        ...(options.name && { name: options.name }),
      });
    return options.retryOnDead === false ? call() : this.retryOnDead(call);
  }

  /** True when an error means the Agent37 instance no longer exists. */
  isInstanceGoneError(error: unknown): boolean {
    return error instanceof Agent37ApiError && error.isNotFound;
  }

  /**
   * Run a function, and if the instance turns out to be gone (deleted
   * elsewhere) or halted (stopped elsewhere), re-acquire it once and retry:
   * a halted instance is started again, a deleted one is recreated.
   */
  async retryOnDead<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this._isRetrying || !(await this.isDeadError(error))) throw error;
      this.logger.debug(LOG_PREFIX + ' Instance for ' + this.id + ' is unavailable; re-acquiring');
      this._isRetrying = true;
      try {
        this.markDetached();
        await this.ensureRunning();
        return await fn();
      } finally {
        this._isRetrying = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async isDeadError(error: unknown): Promise<boolean> {
    if (!(error instanceof Agent37ApiError)) return false;
    if (error.isNotFound) return true;
    // exec answers 400 for an instance that is neither running nor sleeping (stopped, or mid-transition).
    if (error.status !== 400 || !this._instance) return false;
    try {
      const current = await this._client.getInstance(this._instance.id);
      return current.status !== 'running';
    } catch (lookupError) {
      return lookupError instanceof Agent37ApiError && lookupError.isNotFound;
    }
  }

  /** Forget the attached instance (keeping its id for find()) so the next ensureRunning() re-acquires it. */
  private markDetached(): void {
    this._instance = null;
    this.computer?.reset();
    this.status = 'stopped';
  }

  private adopt(instance: Agent37Instance): void {
    this._instance = instance;
    this._instanceId = instance.id;
    this._createdAt = instance.created ? new Date(instance.created * 1000) : new Date();
    this.computer?.reset();
  }

  private buildCreateParams(): Agent37CreateInstanceParams {
    const o = this._options;
    const name = (o.instanceName ?? 'mastra-' + this.id).slice(0, 60);
    return {
      template: this.template,
      ...(this.instanceType && { type: this.instanceType }),
      ...(o.region && { region: o.region }),
      ...(o.resources && { resources: o.resources }),
      name,
      metadata: { ...o.metadata, [SANDBOX_ID_METADATA_KEY]: this.id, [PROVIDER_METADATA_KEY]: 'agent37' },
      ...(o.instanceEnv && { env: o.instanceEnv }),
      auto_sleep: o.autoSleep ?? true,
      idle_timeout_seconds: o.idleTimeoutSeconds ?? 900,
      ...(o.network && { network: o.network }),
      ...o.createParams,
    };
  }

  /** Start or wake an instance as its status requires and wait until it is running. */
  private async bringUp(instance: Agent37Instance, signal?: AbortSignal): Promise<Agent37Instance> {
    let current = instance;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      switch (current.status) {
        case 'running':
          return current;
        case 'stopped':
        case 'sleeping':
          await this._client.startInstance(current.id, signal);
          break;
        case 'failed': {
          const reason = current.status_reason?.message ?? 'unknown reason';
          throw new SandboxError('Agent37 instance ' + current.id + ' failed: ' + reason, 'PROVISIONING_FAILED', {
            instanceId: current.id,
          });
        }
        case 'deleting':
        case 'deleted':
          throw new SandboxError('Agent37 instance ' + current.id + ' was deleted', 'NOT_FOUND', { instanceId: current.id });
        default:
          // provisioning, starting, restarting, updating, waking, stopping: wait for it to settle.
          await sleep(2000);
      }
      current = await this._client.getInstance(current.id, signal);
      if (TRANSITIONAL.includes(current.status) || current.status === 'stopping') await sleep(1000);
    }
    throw new SandboxError(
      'Timed out waiting for Agent37 instance ' + instance.id + ' to be running (last status: ' + current.status + ')',
      'TIMEOUT',
      { instanceId: instance.id },
    );
  }

  /** Find the instance without starting it: by known id, else by metadata tag. */
  private async lookupInstance(): Promise<Agent37Instance | undefined> {
    const id = this._instanceId;
    if (id) {
      try {
        const instance = await this._client.getInstance(id);
        return GONE.includes(instance.status) ? undefined : instance;
      } catch (error) {
        if (error instanceof Agent37ApiError && error.isNotFound) return undefined;
        throw error;
      }
    }
    return this.lookupByMetadata();
  }

  private async lookupByMetadata(): Promise<Agent37Instance | undefined> {
    const instances = await this._client.listInstances();
    return instances.find(i => i.metadata?.[SANDBOX_ID_METADATA_KEY] === this.id && !GONE.includes(i.status));
  }

  /** After a create whose response was lost, poll briefly for the instance it may have created. */
  private async waitForTaggedInstance(): Promise<Agent37Instance | undefined> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const found = await this.lookupByMetadata().catch(() => undefined);
      if (found) return found;
      await sleep(3000);
    }
    return undefined;
  }
}

export type { Agent37ComputerOptions } from './computer';
export type { Agent37ProcessOptions } from './process-manager';
