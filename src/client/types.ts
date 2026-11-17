/**
 * Types for the parts of the Agent37 Cloud REST API this package uses.
 *
 * @see https://www.agent37.com/docs/agents-api/overview
 */

/** Lifecycle state of an Agent37 instance. */
export type Agent37InstanceStatus =
  | 'provisioning'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'starting'
  | 'restarting'
  | 'updating'
  | 'sleeping'
  | 'waking'
  | 'failed'
  | 'deleting'
  | 'deleted';

/** Instance type: `default` (gVisor sandbox), `vm` (full Linux VM), or `performance` (VM with dedicated cores). */
export type Agent37InstanceType = 'default' | 'vm' | 'performance';

/** Region an instance runs in. Fixed for the life of the instance. */
export type Agent37Region = 'us' | 'eu' | 'ap-south';

/** Instance shape. `memory` and `disk` are in GB. */
export interface Agent37Resources {
  cpu: number;
  memory: number;
  disk?: number;
}

/** Outbound network policy for an instance. */
export type Agent37NetworkPolicy = 'allow-all' | 'deny-all' | { allow: string[] };

/** A permanent, unauthenticated URL for one port. */
export interface Agent37PublicPort {
  port: number;
  url: string;
  domain_urls?: string[];
  prefix?: string | null;
  label?: string | null;
  created?: number;
}

/** The instance object returned by create, get, list, and edit. */
export interface Agent37Instance {
  id: string;
  status: Agent37InstanceStatus;
  status_reason?: { code: string; message: string; detail?: string; operation?: string; at?: number } | null;
  template?: string;
  template_revision?: number | null;
  image_ref?: string | null;
  image_digest?: string | null;
  type?: Agent37InstanceType;
  region?: Agent37Region;
  mount_path?: string;
  resources?: Agent37Resources;
  url?: string;
  domain_urls?: string[];
  public_ports?: Agent37PublicPort[];
  name?: string | null;
  metadata?: Record<string, string> | null;
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  network?: Agent37NetworkPolicy;
  slept_at?: number | null;
  past_due?: boolean;
  /** Epoch seconds. */
  created?: number;
}

/** Body of `POST /v1/instances`. Every field is optional. */
export interface Agent37CreateInstanceParams {
  template?: string;
  resources?: Agent37Resources;
  type?: Agent37InstanceType;
  region?: Agent37Region;
  name?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  budget?: { monthly_cap_micros?: number; credit_micros?: number };
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  public_ports?: Array<{ port: number; prefix?: string; label?: string }>;
  network?: Agent37NetworkPolicy;
  mount_path?: string;
  [key: string]: unknown;
}

/** Body of `PATCH /v1/instances/{id}`. */
export interface Agent37UpdateInstanceParams {
  name?: string | null;
  metadata?: Record<string, string> | null;
  env?: Record<string, string | null>;
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  network?: Agent37NetworkPolicy;
}

/** Acknowledgement returned by lifecycle calls (stop, start, sleep, restart). */
export interface Agent37LifecycleAck {
  id: string;
  status: Agent37InstanceStatus;
}

/** Body of `POST /v1/instances/{id}/exec`. */
export interface Agent37ExecParams {
  /** Run through `sh -c`. */
  command: string;
  /** Omit for the image's default user. */
  user?: 'root';
  /** Return `{ pid }` at once instead of waiting for the command. */
  background?: boolean;
  /** Idempotency label: a resend with the same name returns the first run's result. */
  name?: string;
}

/** Result of a foreground exec. A nonzero exit code is still a successful call. */
export interface Agent37ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** True when either stream spilled past its 512 KB cap. */
  truncated: boolean;
}

/** Result of a background exec. */
export interface Agent37BackgroundExecResult {
  pid: number;
}

/** A browser-openable, time-boxed URL for one port. */
export interface Agent37SignedUrl {
  url: string;
  domain_urls?: string[];
  port: number;
  /** Epoch seconds. */
  expires_at: number;
}

/** A restore point. */
export interface Agent37Backup {
  id: string;
  kind: 'manual' | 'daily' | string;
  /** Epoch seconds. */
  created: number;
  size_bytes?: number;
}
