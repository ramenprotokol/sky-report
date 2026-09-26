/**
 * The page shell: loads a report (live, recorded sample or pasted), fills the chart label
 * and the METAR readout, and hands the scene to the renderer. The sky itself is the shader.
 */
import './styles.css';
import { SkyRenderer } from './renderer.ts';
import { buildReport, labelLines, traceLines, tokenExplanation, focusFor, type Report, type ReportSource } from './report.ts';
import { fetchLive, LiveError } from './api.ts';
import { SAMPLES, SAMPLES_RECORDED } from './samples.ts';
import { sceneUniforms, cameraBasis, FOCUS } from '../scene/mapping.ts';
import { TIERS, initialTierIndex, tierIndex } from '../scene/quality.ts';
import { parseMetar, MAX_METAR_CHARS } from '../metar/parse.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const root = document.documentElement;
const canvas = $<HTMLCanvasElement>('sky');
const labelEl = $('label');
const readoutEl = $('readout');
const identText = $('ident-text');
const identBtn = $<HTMLButtonElement>('ident');
const nameEl = $('station-name');
const posEl = $('station-pos');
const obsEl = $('station-obs');
const sunEl = $('station-sun');
const explainEl = $('explain');
const metarEl = $('metar');
const bar = $('bar');
const barForm = $<HTMLFormElement>('bar-form');
const input = $<HTMLInputElement>('icao');
const barError = $('bar-error');
const samplesEl = $('samples');
const notes = $('notes');
const traceEl = $('trace');
const howBtn = $<HTMLButtonElement>('how');
const notesClose = $<HTMLButtonElement>('notes-close');
const qualityBtn = $<HTMLButtonElement>('quality');

const params = new URLSearchParams(location.search);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const forcedStill = params.has('still');
if (params.has('notext')) root.classList.add('notext');

const DEFAULT_HINT = window.matchMedia('(pointer: coarse)').matches
  ? 'Tap any group in the report to see what it means and what it draws.'
  : 'Point at or tab to any group in the report to see what it means and what it draws.';

let current: Report | null = null;
let renderer: SkyRenderer | null = null;
let manualTier: number | null = null;
let frameTimes: number[] = [];
let restoreFocus: HTMLElement | null = null;
let loadSeq = 0;
/** What the explanation line shows when no group is focused: the hint, or a status message. */
let resting = DEFAULT_HINT;

function setResting(text: string): void {
  resting = text;
  explainEl.textContent = text;
}

// ---------------------------------------------------------------- storage (convenience only)

function remember(id: string): void {
  try {
    localStorage.setItem('sky-report:last', id);
  } catch {
    /* private mode or blocked storage: nothing to remember */
  }
}
function recall(): string | null {
  try {
    const v = localStorage.getItem('sky-report:last');
    return v && /^[A-Z][A-Z0-9]{3}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- renderer

function startRenderer(): void {
  const q = params.get('q');
  const qIndex = tierIndex(q);
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
  const start = qIndex >= 0 ? qIndex : initialTierIndex({ coarsePointer: coarse, cssPixels: innerWidth * innerHeight * (devicePixelRatio || 1) ** 2, saveData });
  if (qIndex >= 0) manualTier = qIndex;
  try {
    renderer = new SkyRenderer(canvas, {
      still: forcedStill || reducedMotion.matches,
      startTier: start,
      lockedTier: qIndex >= 0,
      onTierChange: () => updateQualityLabel(),
      onFrame: (ms) => {
        frameTimes.push(ms);
        if (frameTimes.length > 60) frameTimes.shift();
      },
      onDraw: () => {
        if (root.dataset.status !== 'ready') root.dataset.status = 'ready';
      },
    });
  } catch (e) {
    renderer = null;
    root.classList.add('no-gl');
    root.dataset.status = 'ready-no-gl';
    const why = e instanceof Error ? e.message : 'unknown error';
    resting = `The sky can't be drawn here (${why}). The report below still works.`;
    explainEl.textContent = resting;
    return;
  }
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    explainEl.textContent = 'The graphics context was lost. Reload the page to draw the sky again.';
  });
  renderer.resize();
  root.dataset.motion = renderer.isStill ? 'still' : 'moving';
  updateQualityLabel();
}

function updateQualityLabel(): void {
  if (!renderer) {
    qualityBtn.hidden = true;
    return;
  }
  const t = renderer.tier;
  const mode = manualTier === null ? 'auto' : 'fixed';
  let ms = '';
  if (!renderer.isStill && frameTimes.length >= 20) {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    ms = ` · ${Math.round(sorted[Math.floor(sorted.length / 2)]!)} ms/frame here`;
  }
  qualityBtn.textContent = `Quality ${t.name} (${mode})${ms}`;
}

// ---------------------------------------------------------------- showing a report

const range = document.createRange();
/** Tight boxes around each piece of text, so the sky is dimmed only right behind words. */
function textRects(): DOMRect[] {
  const rects: DOMRect[] = [];
  const tight = (el: Element | null) => {
    if (!el || (el as HTMLElement).hidden) return;
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push(r);
  };
  for (const el of labelEl.querySelectorAll('.ident, .hint, p')) tight(el);
  tight(explainEl);
  tight(metarEl);
  tight(readoutEl.querySelector('.meta'));
  if (!bar.hidden) rects.push(bar.getBoundingClientRect());
  return rects;
}

// Test hook for the contrast check (only with ?notext, which hides the words but keeps layout).
if (params.has('notext')) (window as Window & { skyReportTextRects?: () => DOMRect[] }).skyReportTextRects = textRects;

function syncRects(): void {
  renderer?.setTextRects(textRects());
}

function show(report: Report): void {
  current = report;
  const L = labelLines(report);
  identText.textContent = L.ident;
  identBtn.setAttribute('aria-label', `${L.ident}. Change airport`);
  nameEl.textContent = L.name ?? ' ';
  posEl.textContent = L.position;
  obsEl.textContent = L.observed;
  sunEl.textContent = L.sun;
  document.title = `${L.ident} · sky-report`;

  renderTokens(report);
  traceEl.replaceChildren(
    ...traceLines(report).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );
  setResting(DEFAULT_HINT);
  if (renderer) {
    renderer.setFocus(FOCUS.none, 0);
    renderer.setScene(sceneUniforms(report.scene), cameraBasis(report.scene.viewHeadingDeg, report.scene.viewPitchDeg));
  }
  syncRects();
  root.dataset.station = L.ident;
  root.dataset.origin = report.origin;
}

function renderTokens(report: Report): void {
  const raw = report.metar.raw;
  const frag = document.createDocumentFragment();
  let at = 0;
  report.metar.tokens.forEach((t, i) => {
    if (t.start > at) frag.append(raw.slice(at, t.start));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tok';
    b.textContent = t.text;
    b.dataset.i = String(i);
    b.dataset.drawn = t.drives.kind === 'none' ? '0' : '1';
    b.setAttribute('aria-describedby', 'explain');
    frag.append(b);
    at = t.end;
  });
  if (at < raw.length) frag.append(raw.slice(at));
  metarEl.replaceChildren(frag);
}

let clearTimer = 0;
function focusToken(i: number | null): void {
  window.clearTimeout(clearTimer);
  for (const el of metarEl.querySelectorAll('.tok.on')) el.classList.remove('on');
  if (!current || i === null) {
    clearTimer = window.setTimeout(() => {
      explainEl.textContent = resting;
      syncRects();
      renderer?.setFocus(FOCUS.none, 0);
    }, 120);
    return;
  }
  const t = current.metar.tokens[i];
  if (!t) return;
  metarEl.querySelector(`.tok[data-i="${i}"]`)?.classList.add('on');
  const b = document.createElement('b');
  b.textContent = t.text.length > 24 ? `${t.text.slice(0, 22)}…` : t.text;
  const line = document.createElement('span');
  line.append(b, tokenExplanation(current, t));
  explainEl.replaceChildren(line);
  syncRects();
  const [kind, index] = focusFor(t);
  renderer?.setFocus(kind, index);
}

metarEl.addEventListener('pointerover', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tok');
  if (el) focusToken(Number(el.dataset.i));
});
metarEl.addEventListener('pointerout', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tok');
  if (el && document.activeElement !== el) focusToken(null);
});
metarEl.addEventListener('focusin', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tok');
  if (el) focusToken(Number(el.dataset.i));
});
metarEl.addEventListener('focusout', () => focusToken(null));

// ---------------------------------------------------------------- loading

function sampleSource(id: string): ReportSource | undefined {
  return SAMPLES.find((s) => s.id === id.toUpperCase());
}

function showSample(src: ReportSource): void {
  show(buildReport(src, 'sample', Date.now()));
}

async function loadLive(id: string, opts: { quietFallback: boolean }): Promise<boolean> {
  const seq = ++loadSeq;
  root.dataset.loading = id;
  try {
    const src = await fetchLive(id);
    if (seq !== loadSeq) return false;
    const report = buildReport(src, 'live', Date.now());
    if (!report.metar.ok) throw new LiveError('upstream', `${id}: ${report.metar.error ?? 'the report could not be read.'}`);
    show(report);
    remember(id);
    history.replaceState(null, '', `?id=${id}`);
    return true;
  } catch (e) {
    if (seq !== loadSeq) return false;
    const err = e instanceof LiveError ? e : new LiveError('unavailable', 'Live reports are unavailable right now.');
    const sample = sampleSource(id);
    if (err.kind === 'unavailable' && sample) {
      showSample(sample);
      setResting(`${err.message} Showing a recorded ${id} report from ${SAMPLES_RECORDED} instead.`);
      return true;
    }
    if (opts.quietFallback) {
      const fallback = sample ?? SAMPLES[0]!;
      showSample(fallback);
      setResting(`${err.message} Showing a recorded ${fallback.id} report from ${SAMPLES_RECORDED}.`);
      return true;
    }
    openBar('');
    input.value = id;
    barError.textContent = err.message;
    return false;
  } finally {
    if (seq === loadSeq) delete root.dataset.loading;
  }
}

function loadPasted(raw: string): boolean {
  const text = raw.trim().slice(0, MAX_METAR_CHARS);
  const m = parseMetar(text);
  if (!m.ok) {
    barError.textContent = m.error ?? 'That could not be read as a METAR.';
    return false;
  }
  // Use the recorded station position if we happen to have it; otherwise the sun is unknown.
  const known = m.station ? sampleSource(m.station) : undefined;
  show(buildReport({ id: m.station ?? '····', raw: text, obsTime: null, station: known?.station ?? null }, 'pasted', Date.now()));
  return true;
}

// ---------------------------------------------------------------- the ICAO bar

function openBar(initial: string): void {
  if (!bar.hidden) return;
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : identBtn;
  bar.hidden = false;
  barError.textContent = '';
  input.value = initial;
  input.classList.toggle('long', initial.length > 6);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  identBtn.setAttribute('aria-expanded', 'true');
  syncRects();
}

function closeBar(): void {
  if (bar.hidden) return;
  bar.hidden = true;
  identBtn.setAttribute('aria-expanded', 'false');
  syncRects();
  (restoreFocus?.isConnected ? restoreFocus : identBtn).focus({ preventScroll: true });
}

function buildSampleButtons(): void {
  const label = document.createElement('span');
  label.textContent = `Recorded samples, ${SAMPLES_RECORDED} — work offline`;
  samplesEl.append(label);
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.id;
    b.title = s.station?.name ?? s.id;
    b.addEventListener('click', () => {
      loadSeq++;
      restoreFocus = identBtn;
      showSample(s);
      history.replaceState(null, '', `?sample=${s.id}`);
      closeBar();
    });
    samplesEl.append(b);
  }
}

input.addEventListener('input', () => {
  input.classList.toggle('long', input.value.length > 6);
  barError.textContent = '';
});

barForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (v.length > MAX_METAR_CHARS) {
    barError.textContent = `That is too long for a METAR (over ${MAX_METAR_CHARS} characters).`;
    return;
  }
  if (/\s/.test(v)) {
    if (loadPasted(v)) closeBar();
    return;
  }
  const id = v.toUpperCase();
  if (!/^[A-Z][A-Z0-9]{3}$/.test(id)) {
    barError.textContent = 'Use a 4-character ICAO code (like EGLL, KSFO or RJTT), or paste a whole METAR.';
    return;
  }
  barError.textContent = `Fetching ${id}…`;
  const ok = await loadLive(id, { quietFallback: false });
  if (ok) closeBar();
});

identBtn.addEventListener('click', () => openBar(''));
canvas.addEventListener('click', () => {
  if (notes.hidden) openBar('');
});

// ---------------------------------------------------------------- notes

function openNotes(): void {
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : howBtn;
  closeBar();
  notes.hidden = false;
  notesClose.focus();
}
function closeNotes(): void {
  if (notes.hidden) return;
  notes.hidden = true;
  (restoreFocus?.isConnected ? restoreFocus : howBtn).focus({ preventScroll: true });
}
howBtn.addEventListener('click', openNotes);
notesClose.addEventListener('click', closeNotes);

// ---------------------------------------------------------------- quality

qualityBtn.addEventListener('click', () => {
  if (!renderer) return;
  // Cycle: auto → high → medium → low → minimal → auto.
  if (manualTier === null) manualTier = 0;
  else if (manualTier < TIERS.length - 1) manualTier += 1;
  else manualTier = null;
  if (manualTier === null) {
    renderer.controller.locked = false;
    renderer.controller.reset();
  } else {
    renderer.setTier(manualTier);
  }
  frameTimes = [];
  updateQualityLabel();
});
window.setInterval(updateQualityLabel, 2000);

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!notes.hidden) closeNotes();
    else closeBar();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target === input) return;
  if (!notes.hidden) {
    // Keep focus inside the note while it is open.
    if (e.key === 'Tab') {
      e.preventDefault();
      notesClose.focus();
    }
    return;
  }
  if (bar.hidden && (/^[a-zA-Z0-9]$/.test(e.key) || e.key === '/')) {
    e.preventDefault();
    openBar(e.key === '/' ? '' : e.key.toUpperCase());
  }
});

// ---------------------------------------------------------------- motion and layout

reducedMotion.addEventListener('change', () => {
  renderer?.setStill(forcedStill || reducedMotion.matches);
  root.dataset.motion = forcedStill || reducedMotion.matches ? 'still' : 'moving';
  updateQualityLabel();
});

const onResize = () => {
  renderer?.resize();
  syncRects();
};
window.addEventListener('resize', onResize);
new ResizeObserver(() => syncRects()).observe(readoutEl);
void document.fonts?.ready.then(() => syncRects());

// ---------------------------------------------------------------- boot

buildSampleButtons();
startRenderer();

async function boot(): Promise<void> {
  const pasted = params.get('metar');
  const sample = params.get('sample');
  const id = params.get('id');
  if (pasted) {
    if (!loadPasted(pasted.slice(0, MAX_METAR_CHARS))) {
      showSample(SAMPLES[0]!);
      setResting('The METAR in the link could not be read. Showing a recorded sample.');
    }
  } else if (sample && sampleSource(sample)) {
    showSample(sampleSource(sample)!);
  } else {
    const want = id && /^[A-Za-z][A-Za-z0-9]{3}$/.test(id) ? id.toUpperCase() : recall() ?? 'EGLL';
    // Draw a recorded sky immediately, then replace it with the live one.
    showSample(sampleSource(want) ?? SAMPLES[0]!);
    setResting(`Fetching the live ${want} report…`);
    await loadLive(want, { quietFallback: true });
  }
  const f = params.get('focus');
  if (f !== null && current) {
    const i = Number(f);
    if (Number.isInteger(i) && i >= 0 && i < current.metar.tokens.length) focusToken(i);
  }
}

void boot();
