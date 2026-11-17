/**
 * Run commands and move files on a fresh Agent37 instance through a Mastra
 * Workspace, then delete the instance.
 *
 *   AGENT37_API_KEY=sk_live_... pnpm example examples/basic-commands.ts
 */
import { Workspace } from '@mastra/core/workspace';
import { Agent37Sandbox } from '@agentsautonomous.ai/mastra-agent37';

const sandbox = new Agent37Sandbox({
  id: 'mastra-agent37-example-basic-' + Date.now().toString(36),
  metadata: { mastra_test: '1' },
});
const workspace = new Workspace({ sandbox, filesystem: sandbox.filesystem });

try {
  await workspace.init();
  console.log('Instance', sandbox.instanceId, 'is', sandbox.status);

  const uname = await sandbox.executeCommand('uname', ['-srm']);
  console.log('uname:', uname.stdout.trim());

  const env = await sandbox.executeCommand('echo "$GREETING from $(pwd) as $(whoami)"', [], {
    env: { GREETING: 'hello' },
    cwd: '/tmp',
  });
  console.log(env.stdout.trim());

  const failed = await sandbox.executeCommand('ls /does-not-exist');
  console.log('exit code', failed.exitCode, 'stderr:', failed.stderr.trim());

  await sandbox.executeCommand('for i in 1 2 3; do echo "step $i"; sleep 1; done', [], {
    onStdout: chunk => {
      for (const line of chunk.split('\n').filter(Boolean)) console.log('  streamed:', line);
    },
  });

  await sandbox.filesystem.writeFile('/tmp/demo/hello.txt', 'Hello from Mastra\n');
  const text = await sandbox.filesystem.readFile('/tmp/demo/hello.txt', { encoding: 'utf-8' });
  console.log('read back:', JSON.stringify(text));
  console.log('listing:', await sandbox.filesystem.readdir('/tmp/demo'));
} finally {
  await workspace.destroy();
  console.log('Instance deleted');
}
