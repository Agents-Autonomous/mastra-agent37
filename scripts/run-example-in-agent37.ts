/**
 * Run an example inside an Agent37 instance, so the agent can use Agent37's
 * managed LLM router with no model-provider key. The runner instance gets a
 * small one-time budget for the model calls and is deleted afterwards.
 *
 *   AGENT37_API_KEY=sk_live_... pnpm example:in-agent37 examples/computer-use-agent.ts [--budget-usd 1]
 *
 * The runner receives AGENT37_API_KEY (to create the example's own sandboxes)
 * as a per-command environment variable; it is not stored on the instance.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Agent37Sandbox } from '../src';

const example = process.argv[2];
if (!example) throw new Error('Usage: run-example-in-agent37.ts <example file> [--budget-usd N]');
const budgetIndex = process.argv.indexOf('--budget-usd');
const budgetUsd = budgetIndex > 0 ? Number(process.argv[budgetIndex + 1]) : 1;
const repo = join(import.meta.dirname, '..');
const remote = '/home/node/app';

const runner = new Agent37Sandbox({
  id: 'mastra-agent37-example-runner-' + Date.now().toString(36),
  metadata: { mastra_test: '1' },
  createParams: { budget: { credit_micros: Math.round(budgetUsd * 1_000_000) } },
});

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'));
const runnerPackage = {
  name: 'agent37-example-runner',
  private: true,
  type: 'module',
  dependencies: {
    '@mastra/core': pkg.devDependencies['@mastra/core'],
    '@ai-sdk/openai-compatible': pkg.devDependencies['@ai-sdk/openai-compatible'],
    tsx: pkg.devDependencies.tsx,
    zod: pkg.devDependencies.zod,
  },
};

try {
  await runner._start();
  console.log('Runner instance', runner.instanceId);
  for (const file of [...files(join(repo, 'src')), ...files(join(repo, 'examples')), join(repo, 'tsconfig.json')]) {
    if (file.endsWith('.test.ts')) continue;
    await runner.filesystem.writeFile(join(remote, relative(repo, file)), readFileSync(file));
  }
  await runner.filesystem.writeFile(join(remote, 'package.json'), JSON.stringify(runnerPackage, null, 2));
  console.log('Installing dependencies on the runner...');
  const install = await runner.executeCommand('npm install --no-audit --no-fund --loglevel=error', [], {
    cwd: remote,
    timeout: 600_000,
  });
  if (!install.success) throw new Error('npm install failed: ' + install.stderr);

  console.log('Running', example, 'on the runner\n');
  const run = await runner.executeCommand('npx tsx ' + example, [], {
    cwd: remote,
    timeout: 1_800_000,
    env: { AGENT37_API_KEY: process.env.AGENT37_API_KEY, MODEL: process.env.MODEL },
    onStdout: chunk => process.stdout.write(chunk),
    onStderr: chunk => process.stderr.write(chunk),
  });
  console.log('\nExample exited with code', run.exitCode);
  process.exitCode = run.exitCode;
} finally {
  await runner._destroy();
  console.log('Runner instance deleted');
}
