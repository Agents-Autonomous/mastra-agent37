/**
 * Agent37 Computer
 *
 * Implements Mastra's SandboxComputer capability on an Agent37 instance that
 * runs an X11 desktop, such as the agent37-ubuntu VM template (XFCE with
 * Firefox, served over noVNC on port 6080). Agent37 provides the machine,
 * desktop, and exec, but no desktop-control API, so every action is an exec
 * that drives the display with xdotool and captures it with scrot. Both tools
 * are installed with apt on first use when the image lacks them.
 */

import type {
  ComputerPosition,
  ComputerScreenSize,
  ComputerScreenshot,
  SandboxComputer,
} from '@mastra/core/workspace';

import type { Agent37ExecResult } from '../client';
import { randomId, shellQuote } from '../utils/shell';
import type { Agent37Sandbox } from './index';

/** Computer-use configuration. */
export interface Agent37ComputerOptions {
  /** X display to drive, such as ':1'. Default: the first display under /tmp/.X11-unix that accepts connections. */
  display?: string;
  /** Install xdotool and scrot with apt-get when missing. Needs outbound network. Default: true. */
  autoInstall?: boolean;
  /** Port serving the noVNC web client, for streamUrl(). Default: 6080 (agent37-ubuntu). */
  streamPort?: number;
  /** Path of the noVNC page on that port. Default: '/vnc.html'. */
  streamPath?: string;
  /** Lifetime of the signed stream URL in seconds, clamped by Agent37 to [60, 604800]. Default: 3600. */
  streamTtlSeconds?: number;
  /** Delay between typed characters in ms. Default: 12. */
  typingDelayMs?: number;
}

/** Raw bytes per screenshot chunk: base64 of this stays under exec's 512 KB stdout cap. */
const SCREENSHOT_CHUNK_BYTES = 360 * 1024;
const STATE_DIR = '/tmp/.mastra-agent37';

export const COMPUTER_EXIT = {
  installFailed: 30,
  toolsMissing: 31,
  noDisplay: 32,
  displayUnreachable: 33,
  captureFailed: 34,
} as const;

/** Mastra and browser-style key names mapped to X keysyms. Matching is case-insensitive. */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  space: 'space',
  ' ': 'space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  pgup: 'Page_Up',
  pgdn: 'Page_Down',
  capslock: 'Caps_Lock',
  numlock: 'Num_Lock',
  printscreen: 'Print',
  print: 'Print',
  menu: 'Menu',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'super',
  cmd: 'super',
  command: 'super',
  super: 'super',
  win: 'super',
  windows: 'super',
  '+': 'plus',
  plus: 'plus',
  '-': 'minus',
  minus: 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave',
  '[': 'bracketleft',
  ']': 'bracketright',
};

/** Map one key name ('Enter', 'ArrowUp', 'cmd', 'F5', 'a') to an xdotool keysym. */
export function toKeysym(key: string): string {
  const alias = KEY_ALIASES[key.toLowerCase()] ?? KEY_ALIASES[key];
  if (alias) return alias;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  return key;
}

/**
 * Turn a key or chord into an xdotool 'key' argument. A string with '+'
 * between keys ('ctrl+s') is a chord, like an array (['ctrl', 's']).
 */
export function toXdotoolChord(key: string | string[]): string {
  const parts = Array.isArray(key) ? key : splitChord(key);
  if (parts.length === 0) throw new Error('press() needs at least one key');
  return parts.map(toKeysym).join('+');
}

/** Split 'ctrl+s' into keys; a trailing '+' after a separator is the plus key ('ctrl++'). */
function splitChord(key: string): string[] {
  if (key.length <= 1 || !key.includes('+')) return [key];
  const plus = key.endsWith('++');
  const keys = (plus ? key.slice(0, -2) : key).split('+').filter(Boolean);
  return plus ? [...keys, '+'] : keys;
}

/** Round a coordinate to a non-negative integer pixel. */
function px(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Invalid coordinate: ' + value);
  return Math.max(0, Math.round(value));
}

interface DisplayContext {
  display: string;
  xauthority?: string;
}

/** SandboxComputer for an Agent37 instance with an X11 desktop. */
export class Agent37Computer implements SandboxComputer {
  readonly #sandbox: Agent37Sandbox;
  readonly #options: Required<Omit<Agent37ComputerOptions, 'display'>> & { display?: string };
  #ready: Promise<DisplayContext> | null = null;

  constructor(sandbox: Agent37Sandbox, options: Agent37ComputerOptions = {}) {
    this.#sandbox = sandbox;
    this.#options = {
      display: options.display,
      autoInstall: options.autoInstall ?? true,
      streamPort: options.streamPort ?? 6080,
      streamPath: options.streamPath ?? '/vnc.html',
      streamTtlSeconds: options.streamTtlSeconds ?? 3600,
      typingDelayMs: options.typingDelayMs ?? 12,
    };
  }

  /** Forget the detected display, so the next action re-checks the desktop (after a restart or on a new instance). */
  reset(): void {
    this.#ready = null;
  }

  /** Detect the display and install the desktop tools if needed. Memoized until reset(). */
  async ensureReady(): Promise<DisplayContext> {
    if (!this.#ready) {
      this.#ready = this.#setup().catch(error => {
        this.#ready = null;
        throw error;
      });
    }
    return this.#ready;
  }

  async screenshot(): Promise<ComputerScreenshot> {
    const file = STATE_DIR + '/shot-' + randomId(10) + '.png';
    const first = await this.#run(
      [
        'mkdir -p ' + STATE_DIR + '; f=' + shellQuote(file),
        'scrot -z "$f" >/dev/null 2>&1 || import -window root "$f" >/dev/null 2>&1 || exit ' + COMPUTER_EXIT.captureFailed,
        's=$(wc -c <"$f"); echo "$s"',
        'head -c ' + SCREENSHOT_CHUNK_BYTES + ' "$f" | base64 | tr -d \'\\n\'; echo',
        '[ "$s" -le ' + SCREENSHOT_CHUNK_BYTES + ' ] && rm -f "$f"; exit 0',
      ].join('\n'),
    );
    const [sizeLine = '0', data = ''] = first.stdout.split('\n');
    const size = Number(sizeLine.trim());
    const chunks = [Buffer.from(data, 'base64')];
    let offset = chunks[0]!.length;
    try {
      while (offset < size) {
        const next = await this.#sandbox.runScript(
          'tail -c +' + (offset + 1) + ' ' + shellQuote(file) + ' | head -c ' + SCREENSHOT_CHUNK_BYTES + " | base64 | tr -d '\\n'",
          { user: 'root' },
        );
        const chunk = Buffer.from(next.stdout.trim(), 'base64');
        if (next.exit_code !== 0 || chunk.length === 0) throw new Error('Failed to read screenshot: ' + next.stderr.trim());
        chunks.push(chunk);
        offset += chunk.length;
      }
    } finally {
      if (size > SCREENSHOT_CHUNK_BYTES) {
        await this.#sandbox.runScript('rm -f ' + shellQuote(file), { user: 'root' }).catch(() => {});
      }
    }
    const png = Buffer.concat(chunks);
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new Error('Agent37 screenshot did not return a PNG image');
    }
    return { data: new Uint8Array(png), mediaType: 'image/png' };
  }

  async leftClick(x: number, y: number): Promise<void> {
    await this.#xdotool('mousemove ' + px(x) + ' ' + px(y) + ' click 1');
  }

  async rightClick(x: number, y: number): Promise<void> {
    await this.#xdotool('mousemove ' + px(x) + ' ' + px(y) + ' click 3');
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await this.#xdotool('mousemove ' + px(x) + ' ' + px(y) + ' click --repeat 2 --delay 80 1');
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.#xdotool('mousemove ' + px(x) + ' ' + px(y));
  }

  async drag(from: ComputerPosition, to: ComputerPosition): Promise<void> {
    const midX = px((from.x + to.x) / 2);
    const midY = px((from.y + to.y) / 2);
    await this.#xdotool(
      [
        'mousemove', px(from.x), px(from.y), 'mousedown 1 sleep 0.1',
        'mousemove', midX, midY, 'sleep 0.05',
        'mousemove', px(to.x), px(to.y), 'sleep 0.1 mouseup 1',
      ].join(' '),
    );
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    const ticks = Math.max(1, Math.round(amount));
    await this.#xdotool('click --repeat ' + ticks + ' --delay 30 ' + (direction === 'up' ? 4 : 5));
  }

  async type(text: string): Promise<void> {
    if (!text) return;
    const encoded = shellQuote(Buffer.from(text, 'utf-8').toString('base64'));
    await this.#run(
      'printf %s ' + encoded + ' | base64 -d | xdotool type --clearmodifiers --delay ' + this.#options.typingDelayMs + ' --file -',
    );
  }

  async press(key: string | string[]): Promise<void> {
    await this.#xdotool('key --clearmodifiers -- ' + shellQuote(toXdotoolChord(key)));
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    const result = await this.#run('xdotool getdisplaygeometry');
    const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
    if (!width || !height) throw new Error('Could not read the display size: ' + result.stdout.trim());
    return { width, height };
  }

  async getCursorPosition(): Promise<ComputerPosition> {
    const result = await this.#run('xdotool getmouselocation --shell');
    const x = Number(/X=(\d+)/.exec(result.stdout)?.[1]);
    const y = Number(/Y=(\d+)/.exec(result.stdout)?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Could not read the cursor position: ' + result.stdout.trim());
    }
    return { x, y };
  }

  /**
   * A signed, browser-openable noVNC URL for watching (and taking over) the
   * desktop. Anyone holding it has full control until it expires, so share it
   * only with the instance's owner. Resolves null when no URL can be minted.
   */
  async streamUrl(): Promise<string | null> {
    try {
      await this.#sandbox.ensureRunning();
      const signed = await this.#sandbox.signedUrl(this.#options.streamPort, this.#options.streamTtlSeconds);
      const url = new URL(signed);
      url.pathname = this.#options.streamPath;
      url.searchParams.set('autoconnect', '1');
      url.searchParams.set('resize', 'scale');
      return url.toString();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async #xdotool(args: string): Promise<void> {
    await this.#run('xdotool ' + args);
  }

  /** Run a script as root against the desktop's display. Throws on a nonzero exit. */
  async #run(script: string): Promise<Agent37ExecResult> {
    await this.#sandbox.ensureRunning();
    const context = await this.ensureReady();
    const env = ['export DISPLAY=' + shellQuote(context.display)];
    if (context.xauthority) env.push('export XAUTHORITY=' + shellQuote(context.xauthority));
    const result = await this.#sandbox.runScript(env.join('; ') + '\n' + script, { user: 'root' });
    if (result.exit_code === 0) return result;
    if (result.exit_code === COMPUTER_EXIT.captureFailed) {
      throw new Error('Failed to capture the screen: scrot and ImageMagick import both failed');
    }
    // The desktop may have restarted on another display: re-detect on the next call.
    this.reset();
    throw new Error('Desktop command failed (exit ' + result.exit_code + '): ' + (result.stderr || result.stdout).trim());
  }

  async #setup(): Promise<DisplayContext> {
    const fail = (code: number) => '{ tail -n 20 "$log" >&2; exit ' + code + '; }';
    const install = this.#options.autoInstall
      ? [
          '  log=' + STATE_DIR + '/apt.log',
          '  if command -v apt-get >/dev/null 2>&1; then',
          '    (export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends $need) >"$log" 2>&1 || ' + fail(COMPUTER_EXIT.installFailed),
          '  elif command -v apk >/dev/null 2>&1; then',
          '    apk add --no-cache $need >"$log" 2>&1 || ' + fail(COMPUTER_EXIT.installFailed),
          '  else',
          '    echo "no supported package manager to install:$need" >&2; exit ' + COMPUTER_EXIT.installFailed,
          '  fi',
        ]
      : ['  echo "missing desktop tools:$need" >&2; exit ' + COMPUTER_EXIT.toolsMissing];
    const script = [
      'mkdir -p ' + STATE_DIR,
      'need=""',
      'command -v xdotool >/dev/null 2>&1 || need="$need xdotool"',
      'command -v scrot >/dev/null 2>&1 || command -v import >/dev/null 2>&1 || need="$need scrot"',
      'if [ -n "$need" ]; then',
      ...install,
      'fi',
      this.#options.display
        ? 'displays=' + shellQuote(this.#options.display)
        : 'displays=$(for s in /tmp/.X11-unix/X*; do [ -e "$s" ] && echo ":${s##*/X}"; done)',
      '[ -n "$displays" ] || { echo "no X display found under /tmp/.X11-unix" >&2; exit ' + COMPUTER_EXIT.noDisplay + '; }',
      'for d in $displays; do',
      '  if DISPLAY="$d" xdotool getdisplaygeometry >/dev/null 2>&1; then echo "DISPLAY=$d"; echo "XAUTHORITY="; exit 0; fi',
      '  for xa in /root/.Xauthority /home/*/.Xauthority /run/user/*/gdm/Xauthority; do',
      '    [ -f "$xa" ] || continue',
      '    if DISPLAY="$d" XAUTHORITY="$xa" xdotool getdisplaygeometry >/dev/null 2>&1; then echo "DISPLAY=$d"; echo "XAUTHORITY=$xa"; exit 0; fi',
      '  done',
      'done',
      'echo "could not connect to X display(s): $displays" >&2; exit ' + COMPUTER_EXIT.displayUnreachable,
    ].join('\n');
    const result = await this.#sandbox.runScript(script, { user: 'root' });
    if (result.exit_code !== 0) {
      const hint =
        result.exit_code === COMPUTER_EXIT.noDisplay || result.exit_code === COMPUTER_EXIT.displayUnreachable
          ? ' Use a template with a desktop, such as agent37-ubuntu (type "vm"), or set computer.display.'
          : result.exit_code === COMPUTER_EXIT.installFailed
            ? ' Installing xdotool and scrot needs outbound network access; bake them into a custom image for network-restricted instances.'
            : '';
      throw new Error('Agent37 desktop is not available (exit ' + result.exit_code + '): ' + result.stderr.trim() + '.' + hint);
    }
    const display = /DISPLAY=(\S+)/.exec(result.stdout)?.[1];
    const xauthority = /XAUTHORITY=(\S*)/.exec(result.stdout)?.[1];
    if (!display) throw new Error('Agent37 desktop detection returned no display: ' + result.stdout.trim());
    return { display, ...(xauthority && { xauthority }) };
  }
}
