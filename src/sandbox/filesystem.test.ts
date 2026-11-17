/**
 * Filesystem tests. The fake Agent37 runs exec scripts in the local shell, so
 * every file script runs for real against a temp directory.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  NotDirectoryError,
  PermissionError,
  StaleFileError,
} from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Agent37Client } from '../client';
import { FakeAgent37, localExec } from '../test-utils/fake-agent37';
import { READ_CHUNK_BYTES, WRITE_CHUNK_BYTES } from './filesystem';
import { Agent37Sandbox } from './index';

let dir: string;
let fake: FakeAgent37;
let sandbox: Agent37Sandbox;
const p = (...parts: string[]) => join(dir, ...parts);
const execCount = () => fake.callsTo('POST', /exec$/).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a37fs-'));
  fake = new FakeAgent37();
  sandbox = new Agent37Sandbox({ client: new Agent37Client({ apiKey: 'k', fetch: fake.fetch }) });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Agent37Filesystem', () => {
  it('identifies itself', () => {
    const fs = sandbox.filesystem;
    expect(fs.provider).toBe('agent37');
    expect(fs.name).toBe('Agent37Filesystem');
    expect(fs.id).toBe(sandbox.id + '-filesystem');
    expect(fs.getInstructions()).toMatch(/absolute paths/);
  });

  describe('writeFile / readFile', () => {
    it('round-trips text and binary content, creating parents', async () => {
      await sandbox.filesystem.writeFile(p('a/b/c.txt'), "hello 'world' $HOME \\n é");
      expect(readFileSync(p('a/b/c.txt'), 'utf-8')).toBe("hello 'world' $HOME \\n é");
      expect(await sandbox.filesystem.readFile(p('a/b/c.txt'), { encoding: 'utf-8' })).toBe(
        "hello 'world' $HOME \\n é",
      );

      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await sandbox.filesystem.writeFile(p('bin'), bytes);
      const back = await sandbox.filesystem.readFile(p('bin'));
      expect(Buffer.isBuffer(back)).toBe(true);
      expect([...(back as Buffer)]).toEqual([...bytes]);
    });

    it('writes and reads empty files', async () => {
      await sandbox.filesystem.writeFile(p('empty'), '');
      expect(statSync(p('empty')).size).toBe(0);
      expect((await sandbox.filesystem.readFile(p('empty'))).length).toBe(0);
    });

    it('chunks files larger than one exec in both directions', async () => {
      const big = Buffer.alloc(WRITE_CHUNK_BYTES * 2 + 12345);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
      const before = execCount();
      await sandbox.filesystem.writeFile(p('big.bin'), big);
      const writes = execCount() - before;
      expect(writes).toBeGreaterThanOrEqual(3);
      expect(readFileSync(p('big.bin')).equals(big)).toBe(true);

      const mid = execCount();
      const back = (await sandbox.filesystem.readFile(p('big.bin'))) as Buffer;
      expect(execCount() - mid).toBe(Math.ceil(big.length / READ_CHUNK_BYTES));
      expect(back.equals(big)).toBe(true);
    }, 60_000);

    it('keeps the mode of a file it overwrites', async () => {
      writeFileSync(p('script.sh'), 'old');
      chmodSync(p('script.sh'), 0o750);
      await sandbox.filesystem.writeFile(p('script.sh'), 'new');
      expect(readFileSync(p('script.sh'), 'utf-8')).toBe('new');
      expect(statSync(p('script.sh')).mode & 0o777).toBe(0o750);
    });

    it('honors overwrite: false and recursive: false', async () => {
      writeFileSync(p('x'), 'keep');
      await expect(sandbox.filesystem.writeFile(p('x'), 'new', { overwrite: false })).rejects.toBeInstanceOf(
        FileExistsError,
      );
      expect(readFileSync(p('x'), 'utf-8')).toBe('keep');
      await sandbox.filesystem.writeFile(p('y'), 'fresh', { overwrite: false });
      expect(readFileSync(p('y'), 'utf-8')).toBe('fresh');
      await expect(sandbox.filesystem.writeFile(p('no/such/f'), 'x', { recursive: false })).rejects.toBeInstanceOf(
        DirectoryNotFoundError,
      );
      await expect(sandbox.filesystem.writeFile(p('x/child'), 'x', { recursive: false })).rejects.toBeInstanceOf(
        NotDirectoryError,
      );
      await expect(sandbox.filesystem.writeFile(p('x/child'), 'x')).rejects.toBeInstanceOf(NotDirectoryError);
    });

    it('leaves no temp files behind', async () => {
      await sandbox.filesystem.writeFile(p('t.txt'), 'a');
      await sandbox.filesystem.writeFile(p('t.txt'), 'b');
      await sandbox.filesystem.writeFile(p('big'), Buffer.alloc(WRITE_CHUNK_BYTES + 10));
      expect((await sandbox.filesystem.readdir(dir)).map(e => e.name)).toEqual(['big', 't.txt']);
    });

    it('maps read errors to typed errors', async () => {
      mkdirSync(p('d'));
      await expect(sandbox.filesystem.readFile(p('missing'))).rejects.toBeInstanceOf(FileNotFoundError);
      await expect(sandbox.filesystem.readFile(p('d'))).rejects.toBeInstanceOf(IsDirectoryError);
      await expect(sandbox.filesystem.writeFile(p('d'), 'x')).rejects.toBeInstanceOf(IsDirectoryError);
      if (process.getuid?.() !== 0) {
        writeFileSync(p('secret'), 's');
        chmodSync(p('secret'), 0);
        await expect(sandbox.filesystem.readFile(p('secret'))).rejects.toBeInstanceOf(PermissionError);
      }
    });

    it('resolves relative paths from /', async () => {
      const relative = p('rel.txt').slice(1);
      await sandbox.filesystem.writeFile(relative, 'r');
      expect(readFileSync(p('rel.txt'), 'utf-8')).toBe('r');
    });

    it('rejects a write whose expectedMtime no longer matches the file', async () => {
      writeFileSync(p('doc.md'), 'v1');
      const read = await sandbox.filesystem.stat(p('doc.md'));
      await sandbox.filesystem.writeFile(p('doc.md'), 'v2', { expectedMtime: read.modifiedAt });
      expect(readFileSync(p('doc.md'), 'utf-8')).toBe('v2');

      const later = new Date(read.modifiedAt.getTime() + 60_000);
      utimesSync(p('doc.md'), later, later);
      const error = await sandbox.filesystem
        .writeFile(p('doc.md'), 'v3', { expectedMtime: read.modifiedAt })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StaleFileError);
      // utimes takes float seconds, so the stored mtime can be a fraction of a millisecond below `later`.
      expect(Math.abs((error as StaleFileError).actualMtime.getTime() - later.getTime())).toBeLessThanOrEqual(1);
      expect(readFileSync(p('doc.md'), 'utf-8')).toBe('v2');

      const current = await sandbox.filesystem.stat(p('doc.md'));
      const sameSecond = new Date(
        Math.floor(current.modifiedAt.getTime() / 1000) * 1000 +
          (current.modifiedAt.getMilliseconds() === 500 ? 600 : 500),
      );
      utimesSync(p('doc.md'), sameSecond, sameSecond);
      await expect(
        sandbox.filesystem.writeFile(p('doc.md'), 'v4', { expectedMtime: current.modifiedAt }),
      ).rejects.toBeInstanceOf(StaleFileError);
      expect(current.modifiedAt.getMilliseconds()).not.toBe(sameSecond.getMilliseconds());

      await sandbox.filesystem.writeFile(p('new.md'), 'fresh', { expectedMtime: read.modifiedAt });
      expect(readFileSync(p('new.md'), 'utf-8')).toBe('fresh');
    });

    it('fails a chunked upload whose staged chunks were lost instead of publishing a partial file', async () => {
      const big = Buffer.alloc(WRITE_CHUNK_BYTES * 2 + 1, 7);
      let appends = 0;
      fake.execHandler = async (_id, params) => {
        if (params.command.includes('>> "$tmp"') && appends++ === 0) {
          await localExec({ command: `rm -f ${dir}/.big.bin.mastra-tmp-*` });
        }
        return localExec(params);
      };
      await expect(sandbox.filesystem.writeFile(p('big.bin'), big)).rejects.toThrow(
        /interrupted by an instance restart/,
      );
      expect(await sandbox.filesystem.exists(p('big.bin'))).toBe(false);
      const chunkCalls = fake.callsTo('POST', /exec$/).filter(c => String(c.body.command).includes('>> "$tmp"'));
      expect(chunkCalls.length).toBeGreaterThan(0);
    }, 60_000);

    it('cleans up the temp file when a chunked upload fails', async () => {
      const big = Buffer.alloc(WRITE_CHUNK_BYTES * 2 + 1, 1);
      fake.fail(
        c => c.path.endsWith('/exec') && String(c.body.command).includes('>>'),
        400,
        { code: 'invalid_request', message: 'boom' },
        1,
      );
      await expect(sandbox.filesystem.writeFile(p('fail.bin'), big)).rejects.toThrow();
      expect((await sandbox.filesystem.readdir(dir)).map(e => e.name)).toEqual([]);
    }, 60_000);
  });

  describe('appendFile', () => {
    it('appends, creating the file and parents when missing', async () => {
      await sandbox.filesystem.appendFile(p('log/out.txt'), 'one\\n');
      await sandbox.filesystem.appendFile(p('log/out.txt'), Buffer.from('two\\n'));
      expect(readFileSync(p('log/out.txt'), 'utf-8')).toBe('one\\ntwo\\n');
      await expect(sandbox.filesystem.appendFile(p('log'), 'x')).rejects.toBeInstanceOf(IsDirectoryError);
    });
  });

  describe('exists / stat', () => {
    it('reports files, directories, and missing paths', async () => {
      writeFileSync(p('f.json'), '{"a":1}');
      expect(await sandbox.filesystem.exists(p('f.json'))).toBe(true);
      expect(await sandbox.filesystem.exists(p('nope'))).toBe(false);

      const file = await sandbox.filesystem.stat(p('f.json'));
      expect(file).toMatchObject({
        name: 'f.json',
        path: p('f.json'),
        type: 'file',
        size: 7,
        mimeType: 'application/json',
      });
      expect(file.modifiedAt).toBeInstanceOf(Date);
      expect(Math.abs(file.modifiedAt.getTime() - Date.now())).toBeLessThan(60_000);

      const folder = await sandbox.filesystem.stat(dir);
      expect(folder).toMatchObject({ type: 'directory', size: 0 });
      expect(folder.mimeType).toBeUndefined();
      await expect(sandbox.filesystem.stat(p('nope'))).rejects.toBeInstanceOf(FileNotFoundError);
    });
  });

  describe('readdir', () => {
    beforeEach(() => {
      mkdirSync(p('src/deep/deeper'), { recursive: true });
      writeFileSync(p('src/a.ts'), 'aa');
      writeFileSync(p('src/b.md'), 'b');
      writeFileSync(p('src/deep/c.ts'), 'ccc');
      writeFileSync(p('src/deep/deeper/d.ts'), 'd');
      writeFileSync(p('src/tab\\tname.txt'), '');
      symlinkSync(p('src/a.ts'), p('src/link.ts'));
      symlinkSync(p('src/deep'), p('src/dirlink'));
      symlinkSync(p('src/missing'), p('src/broken'));
    });

    it('lists one level with types, sizes, and symlinks', async () => {
      const entries = await sandbox.filesystem.readdir(p('src'));
      expect(entries).toEqual([
        { name: 'a.ts', type: 'file', size: 2 },
        { name: 'b.md', type: 'file', size: 1 },
        { name: 'deep', type: 'directory' },
        { name: 'dirlink', type: 'directory', isSymlink: true, symlinkTarget: p('src/deep') },
        { name: 'link.ts', type: 'file', isSymlink: true, symlinkTarget: p('src/a.ts') },
        { name: 'tab\\tname.txt', type: 'file', size: 0 },
      ]);
    });

    it('recurses, limits depth, and filters by extension', async () => {
      const all = await sandbox.filesystem.readdir(p('src'), { recursive: true });
      expect(all.map(e => e.name)).toContain('deep/deeper/d.ts');
      const shallow = await sandbox.filesystem.readdir(p('src'), { recursive: true, maxDepth: 2 });
      expect(shallow.map(e => e.name)).toContain('deep/c.ts');
      expect(shallow.map(e => e.name)).not.toContain('deep/deeper/d.ts');
      const ts = await sandbox.filesystem.readdir(p('src'), { extension: '.ts' });
      expect(ts.map(e => e.name)).toEqual(['deep', 'dirlink', 'a.ts', 'link.ts'].sort((a, b) => a.localeCompare(b)));
      const md = await sandbox.filesystem.readdir(p('src'), { extension: ['md'] });
      expect(md.filter(e => e.type === 'file').map(e => e.name)).toEqual(['b.md']);
    });

    it('maps errors and cleans up its listing file', async () => {
      await expect(sandbox.filesystem.readdir(p('nope'))).rejects.toBeInstanceOf(DirectoryNotFoundError);
      await expect(sandbox.filesystem.readdir(p('src/a.ts'))).rejects.toBeInstanceOf(NotDirectoryError);
      const listings = fake.callsTo('POST', /exec$/).filter(c => String(c.body.command).startsWith('rm -f '));
      expect(listings.length).toBe(0);
      await sandbox.filesystem.readdir(p('src'));
      const cleanup = fake.callsTo('POST', /exec$/).at(-1)!;
      expect(cleanup.body.command).toMatch(/^rm -f \/tmp\//);
    });
  });

  describe('deleteFile', () => {
    it('deletes files and symlinks, and maps errors', async () => {
      writeFileSync(p('f'), '');
      mkdirSync(p('d'));
      symlinkSync(p('d'), p('dl'));
      await sandbox.filesystem.deleteFile(p('f'));
      await sandbox.filesystem.deleteFile(p('dl'));
      expect(await sandbox.filesystem.exists(p('f'))).toBe(false);
      expect(await sandbox.filesystem.exists(p('d'))).toBe(true);
      await expect(sandbox.filesystem.deleteFile(p('f'))).rejects.toBeInstanceOf(FileNotFoundError);
      await sandbox.filesystem.deleteFile(p('f'), { force: true });
      await expect(sandbox.filesystem.deleteFile(p('d'))).rejects.toBeInstanceOf(IsDirectoryError);
    });
  });

  describe('copyFile', () => {
    it('copies files and directories with overwrite rules', async () => {
      writeFileSync(p('a'), 'A');
      writeFileSync(p('b'), 'B');
      await sandbox.filesystem.copyFile(p('a'), p('out/a2'));
      expect(readFileSync(p('out/a2'), 'utf-8')).toBe('A');
      await sandbox.filesystem.copyFile(p('a'), p('b'));
      expect(readFileSync(p('b'), 'utf-8')).toBe('A');
      writeFileSync(p('b'), 'B');
      await expect(sandbox.filesystem.copyFile(p('a'), p('b'), { overwrite: false })).rejects.toBeInstanceOf(
        FileExistsError,
      );
      expect(readFileSync(p('b'), 'utf-8')).toBe('B');
      await sandbox.filesystem.copyFile(p('a'), p('c'), { overwrite: false });
      expect(readFileSync(p('c'), 'utf-8')).toBe('A');

      mkdirSync(p('tree/sub'), { recursive: true });
      writeFileSync(p('tree/sub/x'), 'X');
      await expect(sandbox.filesystem.copyFile(p('tree'), p('tree2'))).rejects.toBeInstanceOf(IsDirectoryError);
      await sandbox.filesystem.copyFile(p('tree'), p('tree2'), { recursive: true });
      expect(readFileSync(p('tree2/sub/x'), 'utf-8')).toBe('X');
      await expect(
        sandbox.filesystem.copyFile(p('tree'), p('tree2'), { recursive: true, overwrite: false }),
      ).rejects.toBeInstanceOf(FileExistsError);
      await expect(sandbox.filesystem.copyFile(p('a'), p('tree'))).rejects.toBeInstanceOf(IsDirectoryError);
      await expect(sandbox.filesystem.copyFile(p('missing'), p('z'))).rejects.toBeInstanceOf(FileNotFoundError);
    });
  });

  describe('moveFile', () => {
    it('moves files with overwrite rules', async () => {
      writeFileSync(p('a'), 'A');
      writeFileSync(p('b'), 'B');
      await sandbox.filesystem.moveFile(p('a'), p('nested/a'));
      expect(readFileSync(p('nested/a'), 'utf-8')).toBe('A');
      expect(await sandbox.filesystem.exists(p('a'))).toBe(false);
      await expect(sandbox.filesystem.moveFile(p('nested/a'), p('b'), { overwrite: false })).rejects.toBeInstanceOf(
        FileExistsError,
      );
      await sandbox.filesystem.moveFile(p('nested/a'), p('b'));
      expect(readFileSync(p('b'), 'utf-8')).toBe('A');
      await expect(sandbox.filesystem.moveFile(p('a'), p('c'))).rejects.toBeInstanceOf(FileNotFoundError);
    });
  });

  describe('mkdir / rmdir', () => {
    it('creates directories', async () => {
      await sandbox.filesystem.mkdir(p('x/y/z'));
      expect(statSync(p('x/y/z')).isDirectory()).toBe(true);
      await sandbox.filesystem.mkdir(p('x/y/z'));
      await expect(sandbox.filesystem.mkdir(p('q/r'), { recursive: false })).rejects.toBeInstanceOf(
        DirectoryNotFoundError,
      );
      await sandbox.filesystem.mkdir(p('q'), { recursive: false });
      writeFileSync(p('file'), '');
      await expect(sandbox.filesystem.mkdir(p('file'))).rejects.toBeInstanceOf(FileExistsError);
      await expect(sandbox.filesystem.mkdir(p('file/sub'))).rejects.toBeInstanceOf(NotDirectoryError);
    });

    it('removes directories', async () => {
      mkdirSync(p('full/inner'), { recursive: true });
      mkdirSync(p('empty'));
      writeFileSync(p('f'), '');
      await sandbox.filesystem.rmdir(p('empty'));
      expect(await sandbox.filesystem.exists(p('empty'))).toBe(false);
      await expect(sandbox.filesystem.rmdir(p('full'))).rejects.toBeInstanceOf(DirectoryNotEmptyError);
      await sandbox.filesystem.rmdir(p('full'), { recursive: true });
      expect(await sandbox.filesystem.exists(p('full'))).toBe(false);
      await expect(sandbox.filesystem.rmdir(p('full'))).rejects.toBeInstanceOf(DirectoryNotFoundError);
      await sandbox.filesystem.rmdir(p('full'), { force: true });
      await expect(sandbox.filesystem.rmdir(p('f'))).rejects.toBeInstanceOf(NotDirectoryError);
    });
  });

  describe('chmod', () => {
    it('sets permission bits', async () => {
      writeFileSync(p('run'), '');
      await sandbox.filesystem.chmod(p('run'), 0o755);
      expect(statSync(p('run')).mode & 0o777).toBe(0o755);
      await expect(sandbox.filesystem.chmod(p('none'), 0o644)).rejects.toBeInstanceOf(FileNotFoundError);
    });
  });

  it('wraps unmapped failures with the operation, path, and stderr', async () => {
    await sandbox.start();
    fake.execHandler = () => ({ exit_code: 1, stdout: '', stderr: 'disk on fire', truncated: false });
    await expect(sandbox.filesystem.deleteFile(p('f'))).rejects.toThrow(
      /deleteFile .*f failed \(exit 1\): disk on fire/,
    );
  });
});
