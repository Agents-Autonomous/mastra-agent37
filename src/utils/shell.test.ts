import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { envAssignments, isEnvName, randomId, shellQuote } from './shell';

const echo = (quoted: string) => execFileSync('sh', ['-c', 'printf %s ' + quoted], { encoding: 'utf-8' });

describe('shellQuote', () => {
  it('leaves safe strings bare and quotes everything else', () => {
    expect(shellQuote('abc/def.ts')).toBe('abc/def.ts');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('round-trips hostile strings through a real shell', () => {
    for (const value of ["it's", '$HOME', '`id`', 'a\nb', '"q"', '*', '; rm -rf /', '\\', 'é漢字', '-n']) {
      expect(echo(shellQuote(value))).toBe(value);
    }
  });
});

describe('isEnvName / envAssignments', () => {
  it('validates names', () => {
    expect(isEnvName('PATH')).toBe(true);
    expect(isEnvName('_x1')).toBe(true);
    expect(isEnvName('1X')).toBe(false);
    expect(isEnvName('A-B')).toBe(false);
    expect(isEnvName('')).toBe(false);
  });

  it('renders quoted assignments, skipping undefined values and invalid names', () => {
    expect(envAssignments(undefined)).toEqual([]);
    expect(envAssignments({ A: '1', B: undefined, 'BAD-NAME': 'x', C: "it's" })).toEqual(['A=1', "'C=it'\\''s'"]);
  });
});

describe('randomId', () => {
  it('returns lowercase alphanumerics of the requested length', () => {
    expect(randomId()).toMatch(/^[a-z0-9]{12}$/);
    expect(randomId(30)).toMatch(/^[a-z0-9]{30}$/);
    expect(new Set(Array.from({ length: 50 }, () => randomId())).size).toBe(50);
  });
});
