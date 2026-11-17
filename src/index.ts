/**
 * @mastra/agent37: Agent37 Cloud sandbox provider for Mastra workspaces.
 */

export { Agent37Sandbox, SANDBOX_ID_METADATA_KEY, PROVIDER_METADATA_KEY } from './sandbox';
export type { Agent37SandboxOptions, RunScriptOptions } from './sandbox';
export { Agent37Filesystem } from './sandbox/filesystem';
export { Agent37Computer, toKeysym, toXdotoolChord } from './sandbox/computer';
export type { Agent37ComputerOptions } from './sandbox/computer';
export { Agent37ProcessManager, Agent37ProcessHandle } from './sandbox/process-manager';
export type { Agent37ProcessOptions } from './sandbox/process-manager';
export { Agent37Client, Agent37ApiError, DEFAULT_API_URL, DEFAULT_EXEC_URL } from './client';
export type * from './client/types';
export type { Agent37ClientOptions } from './client';
