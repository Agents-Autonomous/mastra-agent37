/**
 * A Mastra agent that uses a full Linux desktop (agent37-ubuntu: XFCE and
 * Firefox) through the workspace computer tools.
 *
 * Model selection:
 * - Inside an Agent37 instance, the agent uses Agent37's managed LLM router
 *   (no provider key; spend comes from the instance budget). MODEL picks an
 *   OpenRouter model id. Run it there with `pnpm example:in-agent37`.
 * - Anywhere else, MODEL is a Mastra model router id such as
 *   'anthropic/claude-sonnet-4-5' with the matching provider key set.
 *
 *   AGENT37_API_KEY=... ANTHROPIC_API_KEY=... pnpm example examples/computer-use-agent.ts
 */
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { Agent37Sandbox } from '@agentsautonomous.ai/mastra-agent37';

import { agent37ManagedModel } from './agent37-managed-model';

const model = process.env.AGENT37_LLM_PROXY_URL
  ? agent37ManagedModel(process.env.MODEL ?? 'anthropic/claude-sonnet-4.5')
  : (process.env.MODEL ?? 'anthropic/claude-sonnet-4-5');

const sandbox = new Agent37Sandbox({
  id: 'mastra-agent37-example-desktop-' + Date.now().toString(36),
  computer: true,
  metadata: { mastra_test: '1' },
});
const workspace = new Workspace({ sandbox });

const agent = new Agent({
  id: 'desktop-agent',
  name: 'Desktop Agent',
  instructions:
    'You operate a Linux desktop through the computer tools. Take a screenshot before acting, ' +
    'act in small steps, and check the result of each step with a screenshot.',
  model,
  workspace,
});

const proofFile = '/tmp/agent-proof.txt';
try {
  await workspace.init();
  console.log('Desktop ready on instance', sandbox.instanceId);
  console.log('Watch live:', await sandbox.computer!.streamUrl());

  const result = await agent.generate(
    'Open a terminal on the desktop (the Terminal Emulator icon is on the left of the desktop; desktop icons open with a double-click), ' +
      `run: echo hello-from-mastra > ${proofFile}` +
      ' and press Enter. Then take a screenshot and tell me what the terminal shows.',
    {
      maxSteps: 30,
      onStepFinish: step => {
        for (const call of step.toolCalls ?? []) {
          const { toolName, args } =
            (call as { payload?: { toolName: string; args: unknown } }).payload ?? (call as any);
          console.log('tool:', toolName, JSON.stringify(args ?? {}).slice(0, 120));
        }
      },
    },
  );
  console.log('\nAgent answer:\n' + result.text);

  const proof = await sandbox.executeCommand('cat', [proofFile]);
  console.log('\n' + proofFile + ':', proof.success ? proof.stdout.trim() : '(missing) ' + proof.stderr.trim());
  console.log('Steps:', result.steps.length, 'Usage:', JSON.stringify(result.usage));
  process.exitCode = proof.stdout.trim() === 'hello-from-mastra' ? 0 : 1;
} finally {
  await workspace.destroy();
  console.log('Desktop instance deleted');
}
