// Minimal Chrome DevTools Protocol driver (no dependencies): launch headless Chrome, emulate a
// device, load a page, collect console errors, hover elements and take screenshots.
// Used by the smoke test and by scripts/shots.mjs.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 800, deviceScaleFactor = 1, mobile = false, reducedMotion = false, args = [] } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found (set CHROME_PATH)');
  const profile = await mkdtemp(join(tmpdir(), 'sky-report-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      '--enable-unsafe-swiftshader',
      ...args,
      `--window-size=${Math.max(width, 500)},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  proc.stderr.on('data', () => {});

  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null);
    if (txt) port = Number(txt.split('\n')[0]);
  }
  if (!port) {
    proc.kill();
    throw new Error('Chrome did not open a debugging port');
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'assert')) {
      problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description ?? d.text}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.trim());
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (reducedMotion) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  return {
    send,
    evaluate,
    problems,
    async goto(url, { readyTimeout = 30000 } = {}) {
      await send('Page.navigate', { url });
      const start = Date.now();
      while (Date.now() - start < readyTimeout) {
        await sleep(150);
        const status = await evaluate('document.documentElement.dataset.status || ""').catch(() => '');
        if (status.startsWith('ready')) return status;
      }
      throw new Error(`page did not become ready within ${readyTimeout} ms`);
    },
    async hover(selector) {
      const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
      if (!box) throw new Error(`no element for ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] });
    },
    async key(key, text = key) {
      const vk = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 }[key];
      const down = { type: vk ? 'rawKeyDown' : 'keyDown', key, code: vk ? key : undefined, windowsVirtualKeyCode: vk };
      if (text && text.length === 1) Object.assign(down, { type: 'keyDown', text });
      await send('Input.dispatchKeyEvent', down);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk });
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      proc.kill();
      await sleep(200);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export { sleep };
