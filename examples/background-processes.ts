/**
 * Background processes: start a web server, open it through a signed URL,
 * talk to a process over stdin, and kill everything.
 *
 *   AGENT37_API_KEY=sk_live_... pnpm example examples/background-processes.ts
 */
import { Agent37Sandbox } from '@agentsautonomous.ai/mastra-agent37';

const sandbox = new Agent37Sandbox({
  id: 'mastra-agent37-example-processes-' + Date.now().toString(36),
  metadata: { mastra_test: '1' },
});

try {
  await sandbox._start();

  const server = await sandbox.processes.spawn(
    `node -e "require('http').createServer((q, s) => s.end('served from Agent37 ' + q.url)).listen(3000)"`,
    { onStderr: chunk => process.stderr.write('[server] ' + chunk) },
  );
  console.log('Server running as pid', server.pid);

  const url = await sandbox.networking.getPortUrl(3000);
  console.log('Signed URL (valid for an hour):', url);
  let body = '';
  for (let attempt = 0; attempt < 15 && !body.startsWith('served'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    body = await fetch(url!)
      .then(r => r.text())
      .catch(() => '');
  }
  console.log('Fetched:', body);

  const calculator = await sandbox.processes.spawn('read a b; echo $((a * b))');
  await calculator.sendStdin('6 7\n');
  await calculator.closeStdin();
  console.log('Calculator said:', (await calculator.wait()).stdout.trim());

  console.log('Processes:', await sandbox.processes.list());
  await server.kill();
  console.log('Server exit code:', server.exitCode);
} finally {
  await sandbox._destroy();
}
