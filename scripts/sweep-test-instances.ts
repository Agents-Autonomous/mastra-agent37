/**
 * Delete Agent37 instances left behind by this package's integration tests
 * and examples: every instance whose metadata carries mastra_test=1, or whose
 * logical sandbox id starts with a test prefix. Run with --dry-run to list only.
 *
 *   AGENT37_API_KEY=sk_live_... pnpm sweep:test-instances [--dry-run]
 */
import { Agent37Client, SANDBOX_ID_METADATA_KEY } from '../src';

const TEST_PREFIXES = ['mastra-agent37-test-', 'mastra-agent37-example-', 'probe-'];
const dryRun = process.argv.includes('--dry-run');

const client = new Agent37Client();
const instances = await client.listInstances();
const leaked = instances.filter(instance => {
  const meta = instance.metadata ?? {};
  const sandboxId = meta[SANDBOX_ID_METADATA_KEY] ?? '';
  return meta.mastra_test === '1' || TEST_PREFIXES.some(prefix => sandboxId.startsWith(prefix));
});

console.log(`Found ${leaked.length} test instance(s) of ${instances.length} in the workspace.`);
for (const instance of leaked) {
  const label = `${instance.id} (${instance.metadata?.[SANDBOX_ID_METADATA_KEY] ?? instance.name ?? 'unnamed'}, ${instance.status})`;
  if (dryRun) {
    console.log('would delete', label);
    continue;
  }
  const deleted = await client.deleteInstance(instance.id);
  console.log(deleted ? 'deleted' : 'already gone', label);
}
