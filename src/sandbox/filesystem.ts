/**
 * Agent37 Sandbox Filesystem
 *
 * The disk of an {@link Agent37Sandbox}, read and written through Agent37's
 * exec endpoint. Agent37 serves a files API only on agent templates (on the
 * agent gateway), so this filesystem works on every template instead: each
 * operation is one exec running a small POSIX script, and file bytes travel
 * base64-encoded in chunks that respect exec's 1 MB request and 512 KB
 * output caps. Large files take one exec per chunk.
 *
 * Paths are absolute inside the instance (relative paths resolve from `/`);
 * this class does not confine paths or symlinks to any root.
 */

import { posix } from 'node:path';

import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  WriteOptions,
} from '@mastra/core/workspace';
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  MastraFilesystem,
  NotDirectoryError,
  PermissionError,
  getMimeType,
} from '@mastra/core/workspace';

import { randomId, shellQuote } from '../utils/shell';
import type { Agent37Sandbox } from './index';

/** Exit codes the file scripts use for outcomes that map to typed errors. */
export const FS_EXIT = {
  notFound: 20,
  isDirectory: 21,
  exists: 22,
  notDirectory: 23,
  destIsDirectory: 24,
  permission: 25,
  parentNotFound: 26,
  notEmpty: 27,
} as const;

/** Raw bytes per read chunk: base64 of this stays under exec's 512 KB stdout cap. */
export const READ_CHUNK_BYTES = 360 * 1024;
/** Raw bytes per write chunk: base64 of this stays under exec's 1 MB request cap. */
export const WRITE_CHUNK_BYTES = 512 * 1024;
/** Default recursion depth for `readdir({ recursive: true })`, matching LocalFilesystem. */
const DEFAULT_MAX_DEPTH = 100;

const toAbsolute = (path: string) => posix.resolve('/', path);
const present = (variable: string) => `{ [ -e "$${variable}" ] || [ -L "$${variable}" ]; }`;
const tempSibling = (path: string) =>
  posix.join(posix.dirname(path), `.${posix.basename(path)}.mastra-tmp-${randomId(10)}`);

function toBuffer(content: FileContent): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
}

function matchesExtension(name: string, extension: ListOptions['extension']): boolean {
  if (!extension) return true;
  const ext = posix.extname(name);
  const wanted = Array.isArray(extension) ? extension : [extension];
  return wanted.some(e => e === ext || e === ext.slice(1) || `.${e}` === ext);
}

type ErrorMap = Partial<Record<keyof typeof FS_EXIT, () => Error>>;

/** The disk of an Agent37 instance, as a Mastra {@link MastraFilesystem}. */
export class Agent37Filesystem extends MastraFilesystem {
  readonly id: string;
  readonly name = 'Agent37Filesystem';
  readonly provider = 'agent37';
  status: ProviderStatus = 'ready';

  readonly #sandbox: Agent37Sandbox;

  constructor(sandbox: Agent37Sandbox) {
    super({ name: 'Agent37Filesystem' });
    this.id = `${sandbox.id}-filesystem`;
    this.#sandbox = sandbox;
  }

  getInstructions(): string {
    return 'Files on the Agent37 instance disk. Use absolute paths.';
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const abs = toAbsolute(path);
    const buffer = await this.#readBytes(
      'readFile',
      [
        `f=${shellQuote(abs)}`,
        `[ -e "$f" ] || exit ${FS_EXIT.notFound}`,
        `[ -d "$f" ] && exit ${FS_EXIT.isDirectory}`,
        `[ -r "$f" ] || exit ${FS_EXIT.permission}`,
      ],
      abs,
      { notFound: () => new FileNotFoundError(path), isDirectory: () => new IsDirectoryError(path), permission: () => new PermissionError(path, 'read') },
    );
    return options?.encoding ? buffer.toString(options.encoding) : buffer;
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.#sandbox.runScript(`[ -e ${shellQuote(toAbsolute(path))} ]`);
    return result.exit_code === 0;
  }

  async stat(path: string): Promise<FileStat> {
    const abs = toAbsolute(path);
    const stdout = await this.#command(
      'stat',
      [
        `f=${shellQuote(abs)}`,
        `[ -e "$f" ] || exit ${FS_EXIT.notFound}`,
        `stat -L -c '%F|%s|%W|%Y' "$f"`,
      ].join('\n'),
      path,
      { notFound: () => new FileNotFoundError(path) },
    );
    const [kind = '', size = '0', birth = '0', mtime = '0'] = stdout.trim().split('|');
    const isDir = kind === 'directory';
    const modifiedAt = new Date(Number(mtime) * 1000);
    const born = Number(birth);
    return {
      name: posix.basename(abs),
      path: abs,
      type: isDir ? 'directory' : 'file',
      size: isDir ? 0 : Number(size),
      createdAt: born > 0 ? new Date(born * 1000) : modifiedAt,
      modifiedAt,
      ...(!isDir && { mimeType: getMimeType(abs) }),
    };
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const abs = toAbsolute(path);
    const depth = options?.recursive ? (options.maxDepth ?? DEFAULT_MAX_DEPTH) : 1;
    // %Y: type after following links, %y: own type, %s: size, %l: link target, %P: path relative to the start.
    const listing = await this.#readBytes(
      'readdir',
      [
        `d=${shellQuote(abs)}`,
        `[ -e "$d" ] || exit ${FS_EXIT.notFound}`,
        `[ -d "$d" ] || exit ${FS_EXIT.notDirectory}`,
        `T=$(mktemp) || exit 1`,
        `find "$d/" -mindepth 1 -maxdepth ${depth} -printf '%Y\\t%y\\t%s\\t%l\\t%P\\0' > "$T" 2>/dev/null`,
        'f="$T"',
      ],
      '$T',
      { notFound: () => new DirectoryNotFoundError(path), notDirectory: () => new NotDirectoryError(path) },
      true,
    );
    const entries: FileEntry[] = [];
    for (const record of listing.toString('utf-8').split('\0')) {
      if (!record) continue;
      const [targetType, ownType, size, target, ...rest] = record.split('\t');
      const name = rest.join('\t');
      // A symlink whose target is missing has no type to report.
      if (targetType !== 'd' && targetType !== 'f') continue;
      const type = targetType === 'd' ? 'directory' : 'file';
      if (type === 'file' && !matchesExtension(name, options?.extension)) continue;
      const link = ownType === 'l';
      entries.push({
        name,
        type,
        ...(type === 'file' && !link && { size: Number(size) }),
        ...(link && { isSymlink: true, symlinkTarget: target }),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const abs = toAbsolute(path);
    const bytes = toBuffer(content);
    const tmp = tempSibling(abs);
    const prepare = [
      `dest=${shellQuote(abs)}; tmp=${shellQuote(tmp)}; parent=${shellQuote(posix.dirname(abs))}`,
      `[ -d "$dest" ] && exit ${FS_EXIT.isDirectory}`,
      options?.recursive === false
        ? `[ -e "$parent" ] || exit ${FS_EXIT.parentNotFound}; [ -d "$parent" ] || exit ${FS_EXIT.notDirectory}`
        : `mkdir -p "$parent" 2>/dev/null || { [ -e "$parent" ] && exit ${FS_EXIT.notDirectory}; exit 1; }`,
      options?.overwrite === false ? `${present('dest')} && exit ${FS_EXIT.exists}` : ':',
    ];
    const publish =
      options?.overwrite === false
        ? [
            `ln "$tmp" "$dest" 2>/dev/null || { rm -f "$tmp"; ${present('dest')} && exit ${FS_EXIT.exists}; exit 1; }`,
            'rm -f "$tmp"',
          ]
        : // Rewrite an existing file in place to keep its mode and owner; otherwise move the new file into place.
          ['if [ -f "$dest" ]; then cat "$tmp" > "$dest"; s=$?; rm -f "$tmp"; exit $s; fi', 'mv -f "$tmp" "$dest"'];
    const errors: ErrorMap = {
      isDirectory: () => new IsDirectoryError(path),
      exists: () => new FileExistsError(path),
      notDirectory: () => new NotDirectoryError(posix.dirname(path)),
      parentNotFound: () => new DirectoryNotFoundError(posix.dirname(path)),
    };
    await this.#upload('writeFile', abs, tmp, bytes, prepare, publish, errors);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const abs = toAbsolute(path);
    const bytes = toBuffer(content);
    const tmp = tempSibling(abs);
    await this.#upload(
      'appendFile',
      abs,
      tmp,
      bytes,
      [
        `dest=${shellQuote(abs)}; tmp=${shellQuote(tmp)}`,
        `[ -d "$dest" ] && exit ${FS_EXIT.isDirectory}`,
        'mkdir -p "$(dirname "$dest")" || exit 1',
      ],
      ['cat "$tmp" >> "$dest"; s=$?; rm -f "$tmp"; exit $s'],
      { isDirectory: () => new IsDirectoryError(path) },
    );
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    const abs = toAbsolute(path);
    await this.#command(
      'deleteFile',
      [
        `f=${shellQuote(abs)}`,
        `${present('f')} || exit ${options?.force ? 0 : FS_EXIT.notFound}`,
        `[ -d "$f" ] && [ ! -L "$f" ] && exit ${FS_EXIT.isDirectory}`,
        'rm -f "$f"',
      ].join('\n'),
      path,
      { notFound: () => new FileNotFoundError(path), isDirectory: () => new IsDirectoryError(path) },
    );
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    const noClobber = options?.overwrite === false;
    const script = [
      `src=${shellQuote(toAbsolute(src))}; dest=${shellQuote(toAbsolute(dest))}`,
      `[ -e "$src" ] || exit ${FS_EXIT.notFound}`,
      'mkdir -p "$(dirname "$dest")" || exit 1',
      'if [ -d "$src" ]; then',
      options?.recursive ? '  :' : `  exit ${FS_EXIT.isDirectory}`,
      noClobber ? `  mkdir "$dest" 2>/dev/null || exit ${FS_EXIT.exists}` : '  mkdir -p "$dest" || exit 1',
      '  cp -R -P "$src"/. "$dest"/ || exit 1',
      '  exit 0',
      'fi',
      noClobber
        ? `${present('dest')} && exit ${FS_EXIT.exists}`
        : `if [ -d "$dest" ]; then exit ${FS_EXIT.destIsDirectory}; fi`,
      ...(noClobber
        ? [
            `tmp=${shellQuote(tempSibling(toAbsolute(dest)))}`,
            'cp "$src" "$tmp" || { rm -f "$tmp"; exit 1; }',
            `ln "$tmp" "$dest" 2>/dev/null || { rm -f "$tmp"; exit ${FS_EXIT.exists}; }`,
            'rm -f "$tmp"',
          ]
        : ['cp "$src" "$dest" || exit 1']),
    ].join('\n');
    await this.#command('copyFile', script, `${src} -> ${dest}`, {
      notFound: () => new FileNotFoundError(src),
      isDirectory: () => new IsDirectoryError(src),
      destIsDirectory: () => new IsDirectoryError(dest),
      exists: () => new FileExistsError(dest),
    });
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    const noClobber = options?.overwrite === false;
    const script = [
      `src=${shellQuote(toAbsolute(src))}; dest=${shellQuote(toAbsolute(dest))}`,
      `${present('src')} || exit ${FS_EXIT.notFound}`,
      noClobber ? `${present('dest')} && exit ${FS_EXIT.exists}` : ':',
      'mkdir -p "$(dirname "$dest")" || exit 1',
      noClobber
        ? `mv -n "$src" "$dest" 2>/dev/null; ${present('src')} && exit ${FS_EXIT.exists}; exit 0`
        : 'mv -f "$src" "$dest"',
    ].join('\n');
    await this.#command('moveFile', script, `${src} -> ${dest}`, {
      notFound: () => new FileNotFoundError(src),
      exists: () => new FileExistsError(dest),
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = toAbsolute(path);
    const script = [
      `d=${shellQuote(abs)}`,
      `if ${present('d')}; then [ -d "$d" ] && exit 0; exit ${FS_EXIT.exists}; fi`,
      options?.recursive === false
        ? `[ -d "$(dirname "$d")" ] || exit ${FS_EXIT.parentNotFound}; mkdir "$d"`
        : `mkdir -p "$d" 2>/dev/null || exit ${FS_EXIT.notDirectory}`,
    ].join('\n');
    await this.#command('mkdir', script, path, {
      exists: () => new FileExistsError(path),
      parentNotFound: () => new DirectoryNotFoundError(posix.dirname(path)),
      notDirectory: () => new NotDirectoryError(path),
    });
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    const abs = toAbsolute(path);
    const script = [
      `d=${shellQuote(abs)}`,
      `${present('d')} || exit ${options?.force ? 0 : FS_EXIT.notFound}`,
      `if [ -L "$d" ] || [ ! -d "$d" ]; then exit ${FS_EXIT.notDirectory}; fi`,
      options?.recursive ? 'rm -rf "$d"' : `rmdir "$d" 2>/dev/null || exit ${FS_EXIT.notEmpty}`,
    ].join('\n');
    await this.#command('rmdir', script, path, {
      notFound: () => new DirectoryNotFoundError(path),
      notDirectory: () => new NotDirectoryError(path),
      notEmpty: () => new DirectoryNotEmptyError(path),
    });
  }

  /** Set a file's permission bits (`chmod`). */
  async chmod(path: string, mode: number): Promise<void> {
    await this.#command(
      'chmod',
      `f=${shellQuote(toAbsolute(path))}; [ -e "$f" ] || exit ${FS_EXIT.notFound}; chmod ${mode.toString(8)} "$f"`,
      path,
      { notFound: () => new FileNotFoundError(path) },
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Run a script and map its exit code to a typed error. Returns stdout. */
  async #command(operation: string, script: string, subject: string, errors: ErrorMap): Promise<string> {
    const result = await this.#sandbox.runScript(script);
    if (result.exit_code === 0) return result.stdout;
    throw this.#toError(operation, subject, result.exit_code, result.stderr, errors);
  }

  #toError(operation: string, subject: string, exitCode: number, stderr: string, errors: ErrorMap): Error {
    for (const [outcome, code] of Object.entries(FS_EXIT)) {
      const toError = errors[outcome as keyof typeof FS_EXIT];
      if (code === exitCode && toError) return toError();
    }
    return new Error(`${operation} ${subject} failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  /**
   * Read a file's bytes in chunks. `prelude` validates and must leave the
   * path to read in `$f`. The first exec returns the size and first chunk;
   * later chunks take one exec each. With `removeAfter`, `$f` is a temp
   * file deleted after the last chunk.
   */
  async #readBytes(
    operation: string,
    prelude: string[],
    path: string,
    errors: ErrorMap,
    removeAfter = false,
  ): Promise<Buffer> {
    const first = await this.#sandbox.runScript(
      [...prelude, `printf %s "$f" | base64 | tr -d '\\n'; echo`, 'wc -c <"$f"', `head -c ${READ_CHUNK_BYTES} "$f" | base64 | tr -d '\\n'; echo`].join('\n'),
    );
    if (first.exit_code !== 0) throw this.#toError(operation, path, first.exit_code, first.stderr, errors);
    const [encodedPath = '', sizeLine = '0', data = ''] = first.stdout.split('\n');
    const file = Buffer.from(encodedPath, 'base64').toString('utf-8');
    const size = Number(sizeLine.trim());
    const chunks = [Buffer.from(data, 'base64')];
    let offset = chunks[0]!.length;
    try {
      while (offset < size) {
        const next = await this.#sandbox.runScript(
          `tail -c +${offset + 1} ${shellQuote(file)} | head -c ${READ_CHUNK_BYTES} | base64 | tr -d '\\n'`,
        );
        if (next.exit_code !== 0) throw this.#toError(operation, path, next.exit_code, next.stderr, errors);
        const chunk = Buffer.from(next.stdout.trim(), 'base64');
        if (chunk.length === 0) break;
        chunks.push(chunk);
        offset += chunk.length;
      }
    } finally {
      if (removeAfter) await this.#sandbox.runScript(`rm -f ${shellQuote(file)}`).catch(() => {});
    }
    return Buffer.concat(chunks);
  }

  /**
   * Upload bytes to `tmp` (one exec per chunk), then run `publish`.
   * Small payloads run prepare, upload, and publish in a single exec.
   */
  async #upload(
    operation: string,
    path: string,
    tmp: string,
    bytes: Buffer,
    prepare: string[],
    publish: string[],
    errors: ErrorMap,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for (let start = 0; start < bytes.length; start += WRITE_CHUNK_BYTES) {
      chunks.push(bytes.subarray(start, start + WRITE_CHUNK_BYTES));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    const writeChunk = (chunk: Buffer, append: boolean) =>
      `printf %s ${shellQuote(chunk.toString('base64'))} | base64 -d ${append ? '>>' : '>'} "$tmp" || { rm -f "$tmp"; exit 1; }`;

    const run = async (lines: string[]) => {
      const result = await this.#sandbox.runScript(lines.join('\n'));
      if (result.exit_code !== 0) throw this.#toError(operation, path, result.exit_code, result.stderr, errors);
    };

    if (chunks.length === 1) {
      await run([...prepare, writeChunk(chunks[0]!, false), ...publish]);
      return;
    }
    const tmpVar = `tmp=${shellQuote(tmp)}`;
    try {
      await run([...prepare, writeChunk(chunks[0]!, false)]);
      for (const chunk of chunks.slice(1, -1)) await run([tmpVar, writeChunk(chunk, true)]);
      await run([...prepare, writeChunk(chunks[chunks.length - 1]!, true), ...publish]);
    } catch (error) {
      await this.#sandbox.runScript(`rm -f ${shellQuote(tmp)}`).catch(() => {});
      throw error;
    }
  }
}
