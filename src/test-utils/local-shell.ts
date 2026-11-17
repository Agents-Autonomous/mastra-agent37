/**
 * The local shell the fake Agent37 runs exec scripts in.
 *
 * The provider's scripts target Agent37's Linux instances: GNU coreutils
 * (`stat -c`, `timeout`), GNU findutils (`find -printf`), and util-linux
 * (`setsid`). On macOS those come from Homebrew, whose GNU tools are put
 * first on PATH here so the scripts run unchanged. TMPDIR is dropped so
 * `mktemp` uses /tmp, as it does on an instance.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { describe, it } from 'vitest';

const homebrewPrefixes = [...new Set([process.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'])].filter(
  (prefix): prefix is string => !!prefix,
);

const gnuToolDirs =
  process.platform === 'darwin'
    ? homebrewPrefixes
        .flatMap(prefix =>
          ['opt/coreutils/libexec/gnubin', 'opt/findutils/libexec/gnubin', 'opt/util-linux/bin'].map(dir =>
            join(prefix, dir),
          ),
        )
        .filter(dir => existsSync(dir))
    : [];

/** Environment for local exec scripts. */
export const localShellEnv: NodeJS.ProcessEnv = { ...process.env };
delete localShellEnv.TMPDIR;
if (gnuToolDirs.length > 0) localShellEnv.PATH = [...gnuToolDirs, process.env.PATH].join(delimiter);

const PROBE = [
  'for tool in setsid mkfifo timeout; do command -v "$tool" >/dev/null || echo "$tool"; done',
  'stat -c %s / >/dev/null 2>&1 || echo "GNU stat (stat -c)"',
  'find / -maxdepth 0 -printf \'\' >/dev/null 2>&1 || echo "GNU find (find -printf)"',
].join('\n');

/** Tools the instance scripts need that the local shell lacks; empty when the scripts can run. */
export const missingLocalTools: string[] = execFileSync('sh', ['-c', PROBE], { env: localShellEnv, encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean);

const INSTALL_HINT =
  process.platform === 'darwin'
    ? 'run `brew install coreutils findutils util-linux`'
    : 'install coreutils, findutils, and util-linux';

/**
 * `describe` for tests that run instance scripts in the local shell. When
 * tools are missing the suite is skipped with a warning naming them, and
 * fails instead under CI so a misconfigured runner cannot pass silently.
 */
export function describeLocalShell(name: string, fn: () => void): void {
  if (missingLocalTools.length === 0) {
    describe(name, fn);
    return;
  }
  const reason = `the local shell lacks ${missingLocalTools.join(', ')}; ${INSTALL_HINT} (see CONTRIBUTING.md)`;
  if (process.env.CI) {
    describe(name, () => {
      it('has the tools the instance scripts need', () => {
        throw new Error(`Cannot run ${name}: ${reason}`);
      });
    });
    return;
  }
  console.warn(`Skipping ${name}: ${reason}`);
  describe.skip(`${name} (skipped: ${reason})`, fn);
}
