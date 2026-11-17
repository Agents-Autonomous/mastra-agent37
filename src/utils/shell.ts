/** Single-quote a string for safe POSIX shell interpolation. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Valid environment variable name for `env NAME=value`. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Render `env -- K=V ...` arguments, dropping undefined values and invalid names. */
export function envAssignments(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && isEnvName(entry[0]))
    .map(([key, value]) => shellQuote(`${key}=${value}`));
}

/** Random lowercase id, safe in paths and exec names. */
export function randomId(length = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}
