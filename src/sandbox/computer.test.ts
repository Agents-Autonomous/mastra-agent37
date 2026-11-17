/**
 * Computer tests. A scripted exec handler stands in for the desktop: it
 * answers display detection, xdotool queries, and screenshot reads, and
 * records every script so the xdotool commands can be checked.
 */
import { describe, expect, it } from 'vitest';

import { Agent37Client } from '../client';
import type { Agent37ExecParams, Agent37ExecResult } from '../client';
import { FakeAgent37 } from '../test-utils/fake-agent37';
import { COMPUTER_EXIT, toKeysym, toXdotoolChord } from './computer';
import type { Agent37ComputerOptions } from './computer';
import { Agent37Sandbox } from './index';

const ok = (stdout = ''): Agent37ExecResult => ({ exit_code: 0, stdout, stderr: '', truncated: false });
const CHUNK = 360 * 1024;

function fakePng(size: number): Buffer {
  const png = Buffer.alloc(size);
  for (let i = 0; i < size; i++) png[i] = (i * 13) % 256;
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  return png;
}

function setup(options: Agent37ComputerOptions | true = true) {
  const fake = new FakeAgent37();
  const scripts: Agent37ExecParams[] = [];
  const desktop = {
    png: fakePng(1000),
    setup: ok('DISPLAY=:1\nXAUTHORITY=\n') as Agent37ExecResult,
    action: undefined as Agent37ExecResult | undefined,
  };
  fake.execHandler = (_id, params) => {
    scripts.push(params);
    const cmd = params.command;
    if (cmd.includes('need=""')) return desktop.setup;
    if (desktop.action) return desktop.action;
    if (cmd.includes('scrot -z')) {
      return ok(desktop.png.length + '\n' + desktop.png.subarray(0, CHUNK).toString('base64') + '\n');
    }
    const tail = /tail -c \+(\d+)/.exec(cmd);
    if (tail) {
      const start = Number(tail[1]) - 1;
      return ok(desktop.png.subarray(start, start + CHUNK).toString('base64'));
    }
    if (cmd.includes('getdisplaygeometry')) return ok('1440 900\n');
    if (cmd.includes('getmouselocation')) return ok('X=700\nY=500\nSCREEN=0\nWINDOW=123\n');
    return ok();
  };
  const client = new Agent37Client({ apiKey: 'k', fetch: fake.fetch, retryBaseDelayMs: 1 });
  const sandbox = new Agent37Sandbox({ client, computer: options });
  const computer = sandbox.computer!;
  const actions = () =>
    scripts.filter(s => !s.command.includes('need=""')).map(s => s.command.split('\n').slice(1).join('\n'));
  return { fake, sandbox, computer, scripts, desktop, actions };
}

describe('key mapping', () => {
  it('maps browser and Mastra key names to X keysyms', () => {
    expect(toKeysym('Enter')).toBe('Return');
    expect(toKeysym('ArrowUp')).toBe('Up');
    expect(toKeysym('esc')).toBe('Escape');
    expect(toKeysym('Backspace')).toBe('BackSpace');
    expect(toKeysym('PageDown')).toBe('Page_Down');
    expect(toKeysym('cmd')).toBe('super');
    expect(toKeysym('f5')).toBe('F5');
    expect(toKeysym('F24')).toBe('F24');
    expect(toKeysym('a')).toBe('a');
    expect(toKeysym('A')).toBe('A');
    expect(toKeysym(' ')).toBe('space');
    expect(toKeysym('/')).toBe('slash');
  });

  it('turns chords into xdotool key arguments', () => {
    expect(toXdotoolChord('ctrl+s')).toBe('ctrl+s');
    expect(toXdotoolChord('Control+Shift+ArrowLeft')).toBe('ctrl+shift+Left');
    expect(toXdotoolChord(['cmd', 'Enter'])).toBe('super+Return');
    expect(toXdotoolChord('+')).toBe('plus');
    expect(toXdotoolChord('ctrl++')).toBe('ctrl+plus');
    expect(toXdotoolChord('ctrl+shift++')).toBe('ctrl+shift+plus');
    expect(() => toXdotoolChord([])).toThrow(/at least one key/);
  });
});

describe('Agent37Computer', () => {
  it('detects the display once, as root, and prefixes actions with it', async () => {
    const { computer, scripts } = setup();
    await computer.leftClick(10, 20);
    await computer.moveMouse(1, 2);
    const detections = scripts.filter(s => s.command.includes('need=""'));
    expect(detections).toHaveLength(1);
    expect(detections[0]!.command).toContain('apt-get install');
    expect(scripts.every(s => s.user === 'root')).toBe(true);
    expect(scripts.at(-1)!.command.split('\n')[0]).toBe('export DISPLAY=:1');
  });

  it('passes XAUTHORITY when detection needs one, and honors a fixed display', async () => {
    const { computer, scripts, desktop } = setup({ display: ':7', autoInstall: false });
    desktop.setup = ok('DISPLAY=:7\nXAUTHORITY=/home/ubuntu/.Xauthority\n');
    await computer.moveMouse(0, 0);
    const detection = scripts[0]!.command;
    expect(detection).toContain('displays=:7');
    expect(detection).not.toContain('apt-get');
    expect(detection).toContain('exit ' + COMPUTER_EXIT.toolsMissing);
    expect(scripts.at(-1)!.command.split('\n')[0]).toBe(
      'export DISPLAY=:7; export XAUTHORITY=/home/ubuntu/.Xauthority',
    );
  });

  it('sends mouse actions as xdotool commands with rounded, clamped coordinates', async () => {
    const { computer, actions } = setup();
    await computer.leftClick(10.4, 20.6);
    await computer.rightClick(-5, 3);
    await computer.doubleClick(64, 180);
    await computer.moveMouse(700, 500);
    await computer.drag({ x: 0, y: 0 }, { x: 100, y: 51 });
    await computer.scroll('up', 3);
    await computer.scroll('down', 0);
    expect(actions()).toEqual([
      'xdotool mousemove 10 21 click 1',
      'xdotool mousemove 0 3 click 3',
      'xdotool mousemove 64 180 click --repeat 2 --delay 80 1',
      'xdotool mousemove 700 500',
      'xdotool mousemove 0 0 mousedown 1 sleep 0.1 mousemove 50 26 sleep 0.05 mousemove 100 51 sleep 0.1 mouseup 1',
      'xdotool click --repeat 3 --delay 30 4',
      'xdotool click --repeat 1 --delay 30 5',
    ]);
    await expect(computer.leftClick(Number.NaN, 1)).rejects.toThrow(/Invalid coordinate/);
  });

  it('types text through base64 so any characters survive, and presses keys', async () => {
    const { computer, actions } = setup({ typingDelayMs: 5 });
    await computer.type('it\'s $HOME; "é"\n');
    await computer.type('');
    await computer.press('ctrl+Enter');
    await computer.press(['alt', 'F4']);
    const [typed, chord, close] = actions();
    const encoded = /printf %s (\S+) \| base64 -d \| xdotool type --clearmodifiers --delay 5 --file -/.exec(typed!);
    expect(Buffer.from(encoded![1]!, 'base64').toString('utf-8')).toBe('it\'s $HOME; "é"\n');
    expect(chord).toBe('xdotool key --clearmodifiers -- ctrl+Return');
    expect(close).toBe('xdotool key --clearmodifiers -- alt+F4');
    expect(actions()).toHaveLength(3);
  });

  it('reads the screen size and cursor position', async () => {
    const { computer, desktop } = setup();
    expect(await computer.getScreenSize()).toEqual({ width: 1440, height: 900 });
    expect(await computer.getCursorPosition()).toEqual({ x: 700, y: 500 });
    desktop.action = ok('garbage');
    await expect(computer.getScreenSize()).rejects.toThrow(/display size/);
    await expect(computer.getCursorPosition()).rejects.toThrow(/cursor position/);
  });

  it('returns small and multi-chunk screenshots as PNG bytes', async () => {
    const { computer, desktop, scripts } = setup();
    const small = await computer.screenshot();
    expect(small.mediaType).toBe('image/png');
    expect(Buffer.from(small.data).equals(desktop.png)).toBe(true);

    desktop.png = fakePng(CHUNK * 2 + 777);
    const before = scripts.length;
    const big = await computer.screenshot();
    expect(Buffer.from(big.data).equals(desktop.png)).toBe(true);
    const reads = scripts.slice(before);
    expect(reads.filter(s => /tail -c/.test(s.command))).toHaveLength(2);
    expect(reads.at(-1)!.command).toMatch(/^rm -f /);
  });

  it('rejects screenshots that are not PNG and maps capture failures', async () => {
    const { computer, desktop } = setup();
    desktop.png = Buffer.from('not a png at all');
    await expect(computer.screenshot()).rejects.toThrow(/did not return a PNG/);
    desktop.action = { exit_code: COMPUTER_EXIT.captureFailed, stdout: '', stderr: '', truncated: false };
    await expect(computer.screenshot()).rejects.toThrow(/Failed to capture the screen/);
  });

  it('explains a missing desktop and retries detection on the next call', async () => {
    const { computer, desktop, scripts } = setup();
    desktop.setup = { exit_code: COMPUTER_EXIT.noDisplay, stdout: '', stderr: 'no X display found', truncated: false };
    await expect(computer.leftClick(1, 1)).rejects.toThrow(/no X display found.*agent37-ubuntu/);
    desktop.setup = {
      exit_code: COMPUTER_EXIT.installFailed,
      stdout: '',
      stderr: 'E: unable to fetch',
      truncated: false,
    };
    await expect(computer.leftClick(1, 1)).rejects.toThrow(/outbound network/);
    desktop.setup = ok('DISPLAY=:1\nXAUTHORITY=\n');
    await computer.leftClick(1, 1);
    expect(scripts.filter(s => s.command.includes('need=""'))).toHaveLength(3);
  });

  it('re-detects the display after a failed action or reset()', async () => {
    const { computer, desktop, scripts } = setup();
    await computer.moveMouse(1, 1);
    desktop.action = { exit_code: 1, stdout: '', stderr: "Can't open display", truncated: false };
    await expect(computer.moveMouse(1, 1)).rejects.toThrow(/Desktop command failed \(exit 1\): Can't open display/);
    desktop.action = undefined;
    await computer.moveMouse(1, 1);
    computer.reset();
    await computer.moveMouse(1, 1);
    expect(scripts.filter(s => s.command.includes('need=""'))).toHaveLength(3);
  });

  it('mints a signed noVNC stream URL, or null when it cannot', async () => {
    const { computer, fake, sandbox } = setup({ streamPort: 6081, streamTtlSeconds: 120 });
    const url = new URL((await computer.streamUrl())!);
    expect(url.pathname).toBe('/vnc.html');
    expect(url.host).toBe(sandbox.instanceId + '-6081.agent37.app');
    expect(url.searchParams.get('a37_token')).toBe('tok123');
    expect(url.searchParams.get('autoconnect')).toBe('1');
    expect(url.searchParams.get('resize')).toBe('scale');
    expect(fake.callsTo('POST', /signed-url$/)[0]!.body).toMatchObject({ port: 6081, ttl_seconds: 120 });
    fake.fail(c => c.path.endsWith('/signed-url'), 400, { code: 'invalid_request', message: 'no' }, 5);
    expect(await computer.streamUrl()).toBeNull();
  });
});
