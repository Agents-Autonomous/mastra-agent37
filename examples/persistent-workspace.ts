/**
 * A workspace that survives restarts. The logical id is stored on the Agent37
 * instance, so any process that builds a sandbox with the same id reconnects
 * to the same machine, with its files (and, after a sleep, its processes).
 *
 *   AGENT37_API_KEY=sk_live_... pnpm example examples/persistent-workspace.ts
 *   AGENT37_API_KEY=sk_live_... pnpm example examples/persistent-workspace.ts --destroy
 */
import { Agent37Sandbox } from '@mastra/agent37';

const id = 'mastra-agent37-example-persistent';
const sandbox = new Agent37Sandbox({ id, metadata: { mastra_test: '1' } });

if (process.argv.includes('--destroy')) {
  // _destroy() is a no-op for a sandbox this process never started, so call the
  // provider's destroy() directly: it finds the instance by id and deletes it.
  await sandbox.destroy();
  console.log('Deleted the instance for', id);
  process.exit(0);
}

await sandbox._start();
console.log('Connected to instance', sandbox.instanceId);

const counter = await sandbox.executeCommand('n=$(cat ~/runs 2>/dev/null || echo 0); n=$((n+1)); echo $n > ~/runs; echo $n');
console.log('This instance has been used', counter.stdout.trim(), 'time(s)');

// stopMode 'sleep' (the default) checkpoints memory and processes, billing disk only.
await sandbox._stop();
console.log('Instance is now', (await sandbox.client.getInstance(sandbox.instanceId!)).status);
console.log('Run again to reconnect, or pass --destroy to delete it.');
