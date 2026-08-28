#!/usr/bin/env node
/**
 * make-tiktok.mjs — short vertical clips of the real site, one per anime.
 *
 *   node make-tiktok.mjs 9253 "Cowboy Bebop" 5114
 *   node make-tiktok.mjs --list titles.txt --theme dark
 *
 * ONE CONTINUOUS TAKE. The title card and the end card are overlays injected
 * into the page, not separate clips stitched afterwards, so there is no cut to
 * flash and nothing to edit. Playwright drives a 390x844 viewport — the real
 * mobile CSS, the same one a phone gets — types the anime into the search box
 * a character at a time, taps the suggestion, and holds on the card the site
 * actually returns. ffmpeg-static turns the WebM into an MP4; there is no
 * system ffmpeg on this machine.
 *
 * No audio, deliberately. Reach on TikTok comes from the trending sound, those
 * change weekly, and they get picked per video by hand. Automating the visual
 * is the saving; automating the audio would work against it.
 *
 * Nothing in the site is touched. The overlays and the address bar are
 * injected at runtime by this script and exist only inside the recording.
 *
 * ---------------------------------------------------------------------------
 * Two things about the capture, both found by measuring rather than guessing:
 *
 * 1. Playwright records at CSS-pixel resolution and does not scale up. Asking
 *    for a 1080-wide video from a 390-wide viewport does not give you a
 *    1080-wide picture — it gives you a 390-wide picture sitting in the corner
 *    of a grey 1080-wide frame, because the recorder pads rather than scales.
 *    Chromium's own --force-device-scale-factor=3 is what actually raises the
 *    capture, to a native 1170x2532. Do not remove that launch flag.
 *
 * 2. A 390x844 phone is 9:19.5 and TikTok wants 9:16, so the frame is scaled
 *    to height and padded at the sides with the page's own background colour.
 *    The site's background is flat, so the join is invisible and nothing is
 *    cropped away. Cropping to 9:16 instead would cut about 75 CSS pixels off
 *    the top and bottom of the card, which is where the title sits.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Timings and framing
 * ------------------------------------------------------------------ */

const VIEWPORT = { width: 390, height: 844 };  // iPhone 12/13/14 logical size
const SCALE = 3;                               // capture at 1170x2532
const OUT = { width: 1080, height: 1920 };     // what TikTok wants
const ADDR_H = 46;                             // the address bar, in CSS px

/* Every hold is a range, not a number. A batch of clips identical to the frame
 * with one word swapped reads as spam to TikTok and gets throttled, which
 * defeats the point of generating them in bulk. */
const T = {
  titleHold:   [1500, 2400],   // the hook, before the site appears
  titleFade:   [300, 440],
  beforeTap:   [320, 620],     // a beat before the finger lands
  perChar:     [58, 132],      // typing, jittered per keystroke
  afterType:   [420, 820],     // reading the dropdown
  afterPick:   [180, 360],
  holdTop:     [900, 1600],    // the card, from the top
  scrollDur:   [2200, 3400],   // the slow pan down it
  holdBottom:  [1500, 2600],
  endFade:     [260, 380],
  endHold:     [1700, 2600],
};

/* The hook. The kicker renders in small caps above the title, the hook line in
 * the accent colour below it, so "YOU'VE SEEN / Steins;Gate / Watch this next."
 * All eight say the same thing; they exist so a batch is not eight copies. */
const HOOKS = [
  ['you have seen',   'Watch this next.'],
  ['finished',        'Watch this next.'],
  ['if you liked',    'Start this next.'],
  ['already watched', 'Here is your next one.'],
  ['seen',            'Watch this one next.'],
  ['done with',       'Try this next.'],
  ['loved',           'This is your next watch.'],
  ['watched',         'Now watch this.'],
];

/* End-card sub-lines. All of them are true — see CLAUDE.md. */
const ENDINGS = [
  'type what you have watched, get what is next',
  'free, no account, no sign-up',
  '4,400 series you can start from episode one',
  'no sequels, nothing you need backstory for',
  'one anime in, one anime out',
];

const SITE_URL = 'whatanimeshouldiwatchnext.com';

const THEMES = {
  dark:  { bg: '#17181a', scheme: 'dark' },
  light: { bg: '#ffffff', scheme: 'light' },
};

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    out: path.join(ROOT, 'tiktok'),
    theme: 'dark',
    port: 8777,
    seed: null,
    keepWebm: false,
    dry: false,
    wanted: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') opts.out = path.resolve(argv[++i]);
    else if (arg === '--theme') opts.theme = argv[++i];
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--seed') opts.seed = Number(argv[++i]);
    else if (arg === '--keep-webm') opts.keepWebm = true;
    else if (arg === '--dry') opts.dry = true;
    else if (arg === '--list') {
      const file = argv[++i];
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean)
        .forEach((line) => opts.wanted.push(line));
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      opts.wanted.push(arg);
    }
  }
  if (!THEMES[opts.theme]) throw new Error(`--theme must be dark or light`);
  if (!opts.wanted.length) {
    throw new Error(
      'Nothing to make. Pass MAL ids or titles:\n'
      + '  node make-tiktok.mjs 9253 "Cowboy Bebop"\n'
      + '  node make-tiktok.mjs --list titles.txt'
    );
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * Randomness — seeded, so a batch can be reproduced when one clip is wrong
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rnd, [lo, hi]) => Math.round(lo + rnd() * (hi - lo));

/* A deck rather than a draw, so eight clips get eight different hooks instead
 * of the same one three times by chance. */
function dealer(items, rnd) {
  let deck = [];
  return () => {
    if (!deck.length) {
      deck = [...items];
      for (let i = deck.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    return deck.pop();
  };
}

/* ------------------------------------------------------------------ *
 * The catalogue — resolve ids and titles without booting the app
 * ------------------------------------------------------------------ */

function loadCatalogue() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'anime.json'), 'utf8'));
  return raw.anime.map((row) => ({
    id: row.i,
    rank: row.r,
    title: row.t,
    english: row.en || '',
    year: row.y,
    type: row.ty,
    image: row.im ? `https://cdn.myanimelist.net/images/anime/${row.im}` : '',
    genres: row.g || [],
  }));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function resolve(catalogue, wanted) {
  if (/^\d+$/.test(wanted)) {
    const byId = catalogue.find((a) => a.id === Number(wanted));
    if (byId) return byId;
    // Fall through: a bare number could still be a title, e.g. "91 Days".
  }
  const q = norm(wanted);
  const exact = catalogue.filter((a) => norm(a.title) === q || norm(a.english) === q);
  if (exact.length) return exact[0];
  const starts = catalogue.filter((a) => norm(a.title).startsWith(q) || norm(a.english).startsWith(q));
  if (starts.length) return starts.sort((a, b) => a.rank - b.rank)[0];
  const holds = catalogue.filter((a) => norm(a.title).includes(q) || norm(a.english).includes(q));
  if (holds.length) return holds.sort((a, b) => a.rank - b.rank)[0];
  return null;
}

function slugify(title) {
  return String(title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/* ------------------------------------------------------------------ *
 * The local server. `npm run serve` is exactly this, spawned directly so it
 * can be killed cleanly on Windows. An already-running one is left alone.
 * ------------------------------------------------------------------ */

function portOpen(port) {
  return new Promise((resolve_) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); resolve_(open); };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function ensureServer(port) {
  if (await portOpen(port)) {
    console.log(`Using the server already on port ${port}.`);
    return null;
  }
  console.log(`Starting python -m http.server ${port} (what npm run serve runs)…`);
  const child = spawn('python', ['-m', 'http.server', String(port)], {
    cwd: ROOT, stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(port)) return child;
  }
  stopServer(child);
  throw new Error(`Could not start a server on port ${port}. Run "npm run serve" yourself and try again.`);
}

/* child.kill() left the server running: `python` on Windows is often a shim
 * that launches the real interpreter as a child, so terminating what was
 * spawned orphans the process actually holding the port, and the next run
 * silently reuses a server it did not start. Kill the tree. */
function stopServer(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      return;
    } catch { /* fall through to the plain kill */ }
  }
  child.kill();
}

/* ------------------------------------------------------------------ *
 * The overlays. Injected before the page's own scripts run, so the title card
 * is already up for the very first painted frame and the site loading behind
 * it is never seen — no white flash, and no timing variance from the load.
 * ------------------------------------------------------------------ */

function overlayInit(cfg) {
  /* An init script runs before the document exists, so there is no
     documentElement to paint yet — reaching for one here threw, and a throw
     this early means window.__wx never gets defined and every later call
     fails with "cannot read properties of undefined". Paint on the first
     frame that has one instead. */
  const paint = () => {
    if (!document.documentElement) { requestAnimationFrame(paint); return; }
    document.documentElement.style.background = cfg.bg;
  };
  paint();

  const css = `
    html, body { background: ${cfg.bg}; }
    body { padding-top: ${cfg.addrH}px; }
    #search-view { min-height: calc(100vh - ${cfg.addrH}px); }

    .wx-addr {
      position: fixed; top: 0; left: 0; right: 0; height: ${cfg.addrH}px;
      z-index: 90; display: flex; align-items: center; justify-content: center;
      background: ${cfg.bg}; border-bottom: 1px solid var(--border);
    }
    .wx-addr-pill {
      display: flex; align-items: center; gap: 7px;
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 999px; padding: 6px 15px; max-width: 88%;
      font: 500 13px/1.2 var(--wx-font); color: var(--fg-dim);
      white-space: nowrap; overflow: hidden;
    }
    .wx-addr-pill b { color: var(--fg); font-weight: 600; }
    .wx-lock { width: 11px; height: 11px; flex: none; fill: var(--fg-faint); }

    .wx-tap {
      position: fixed; z-index: 95; width: 48px; height: 48px;
      margin: -24px 0 0 -24px; border-radius: 50%;
      border: 2px solid var(--accent); background: var(--accent-soft);
      pointer-events: none; opacity: 0;
    }
    .wx-tap.wx-on { animation: wx-tap 640ms ease-out forwards; }
    @keyframes wx-tap {
      0%   { opacity: .95; transform: scale(.35); }
      70%  { opacity: .45; }
      100% { opacity: 0;   transform: scale(1.3); }
    }

    /* Solid --bg, never a gradient: the frame is padded at the sides with this
       same colour, so anything but a flat fill would show the join. */
    .wx-card {
      position: fixed; inset: 0; z-index: 100; background: var(--bg);
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 0 34px; text-align: center;
      font-family: var(--wx-font); opacity: 1;
      transition: opacity var(--wx-fade, 500ms) ease;
    }
    .wx-card.wx-off { opacity: 0; pointer-events: none; }

    .wx-poster {
      width: 194px; aspect-ratio: 2 / 3; margin-bottom: 26px;
      border-radius: 14px; overflow: hidden; background: var(--surface-2);
      box-shadow: 0 18px 44px rgba(0, 0, 0, .45);
    }
    .wx-poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .wx-kicker {
      font: 600 12px/1 var(--wx-font); letter-spacing: .16em;
      text-transform: uppercase; color: var(--fg-faint); margin-bottom: 13px;
    }
    .wx-title {
      font: 700 28px/1.2 var(--wx-font); letter-spacing: -.02em;
      color: var(--fg); margin: 0 0 18px;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .wx-hook { font: 700 24px/1.25 var(--wx-font); color: var(--accent); margin: 0; }

    .wx-mark { font-weight: 700; letter-spacing: -.03em; line-height: 1.06; font-size: 38px; }
    .wx-mark div { white-space: nowrap; }
    .wx-url {
      margin-top: 26px; padding: 11px 20px; border-radius: 999px;
      border: 1px solid var(--border); background: var(--surface-2);
      font: 600 19px/1 var(--wx-font); color: var(--fg); white-space: nowrap;
    }
    .wx-sub { margin-top: 18px; font: 400 14px/1.4 var(--wx-font); color: var(--fg-dim); }
  `;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  let mounted = null;
  const ready = new Promise((resolve_) => { mounted = resolve_; });
  const parts = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function mount() {
    if (!document.body) { requestAnimationFrame(mount); return; }

    const style = document.createElement('style');
    style.textContent = `:root { --wx-font: ${cfg.font}; }\n${css}`;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.innerHTML = `
      <div class="wx-addr">
        <span class="wx-addr-pill">
          <svg class="wx-lock" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2M9 6a3 3 0 0 1 6 0v2H9zm3 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4"/></svg>
          <span><b>${esc(cfg.site)}</b></span>
        </span>
      </div>
      <div class="wx-tap"></div>
      <div class="wx-card wx-card-title">
        <div class="wx-poster">${cfg.poster ? '<img src="' + esc(cfg.poster) + '" alt="">' : ''}</div>
        <div class="wx-kicker">${esc(cfg.kicker)}</div>
        <h2 class="wx-title">${esc(cfg.title)}</h2>
        <p class="wx-hook">${esc(cfg.hook)}</p>
      </div>
      <div class="wx-card wx-card-end wx-off">
        <div class="wx-mark">
          <div><span class="w-what">what</span><span class="w-anime">anime</span><span class="w-should">should</span></div>
          <div><span class="w-i">i</span><span class="w-watch">watch</span><span class="w-next">next</span></div>
        </div>
        <div class="wx-url">${esc(cfg.site)}</div>
        <div class="wx-sub">${esc(cfg.ending)}</div>
      </div>`;

    parts.tap = root.querySelector('.wx-tap');
    parts.title = root.querySelector('.wx-card-title');
    parts.end = root.querySelector('.wx-card-end');
    parts.poster = root.querySelector('.wx-poster img');
    document.body.appendChild(root);
    mounted();
  }
  mount();

  window.__wx = {
    ready: () => ready,

    /* The title card holds the poster, so the poster has to be there before
       the clip starts or the hook frame is an empty rectangle. */
    async posterReady(timeout) {
      await ready;
      const img = parts.poster;
      if (!img || img.complete) return;
      await Promise.race([
        new Promise((r) => { img.onload = img.onerror = r; }),
        wait(timeout),
      ]);
    },

    async fadeTitle(ms) {
      await ready;
      parts.title.style.setProperty('--wx-fade', `${ms}ms`);
      parts.title.classList.add('wx-off');
      await wait(ms);
    },

    async fadeEnd(ms) {
      await ready;
      parts.end.style.setProperty('--wx-fade', `${ms}ms`);
      parts.end.classList.remove('wx-off');
      await wait(ms);
    },

    async tap(x, y) {
      await ready;
      parts.tap.classList.remove('wx-on');
      parts.tap.style.left = `${x}px`;
      parts.tap.style.top = `${y}px`;
      void parts.tap.offsetWidth;          // restart the animation
      parts.tap.classList.add('wx-on');
    },

    /* Hand-rolled rather than scroll-behavior: smooth, because the browser
       picks its own duration and a pan that finishes early leaves the card
       sitting still for the rest of the shot. */
    scrollTo(target, ms) {
      const from = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const to = Math.max(0, Math.min(target, max));
      if (Math.abs(to - from) < 2) return Promise.resolve();
      const started = performance.now();
      return new Promise((done) => {
        const step = (now) => {
          const p = Math.min(1, (now - started) / ms);
          const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          window.scrollTo(0, from + (to - from) * eased);
          if (p < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    },

    /* Where to stop the pan: the bottom of the card, with a little air under
       it. The card is about 1000px tall against an 844px viewport, so it can
       never all be on screen at once — the hold at the top plus the pan down
       is how the whole of it gets seen. */
    scrollTargetForCard() {
      const hero = document.querySelector('.hero');
      if (!hero) return 0;
      const rect = hero.getBoundingClientRect();
      return rect.bottom + window.scrollY - window.innerHeight + 26;
    },

    /* A card whose poster is still loading, or whose synopsis lands mid-hold,
       reads as a glitch. Wait for both before the timer starts. */
    async cardSettled(timeout) {
      const started = Date.now();
      const left = () => Math.max(0, timeout - (Date.now() - started));

      const body = document.getElementById('result-body');
      if (!body) return;

      const banner = body.querySelector('.hero-banner');
      const url = banner && /url\(["']?(.+?)["']?\)/.exec(banner.style.backgroundImage || '');
      const pre = url ? new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = url[1]; }) : null;

      const images = [...body.querySelectorAll('img')].map((img) => (
        img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; })
      ));

      const synopsis = new Promise((r) => {
        const el = document.getElementById('hero-synopsis');
        if (!el) return r();
        if (el.textContent.trim()) return r();
        const obs = new MutationObserver(() => {
          if (el.textContent.trim()) { obs.disconnect(); r(); }
        });
        obs.observe(el, { childList: true, characterData: true, subtree: true });
        setTimeout(() => { obs.disconnect(); r(); }, timeout);
      });

      await Promise.race([
        Promise.all([...images, synopsis, pre].filter(Boolean)),
        wait(left()),
      ]);
    },

    /* Which suggestion is the one we asked for. Usually the first, but not
       always — a prefix can put a better-ranked relative above it. */
    suggestionIndex(title) {
      const rows = [...document.querySelectorAll('#suggestions .suggestion')];
      if (!rows.length) return -1;
      const want = title.toLowerCase();
      const hit = rows.findIndex((li) => (
        li.querySelector('.suggestion-title')?.textContent.trim().toLowerCase() === want
      ));
      return hit;
    },
  };
}

/* ------------------------------------------------------------------ *
 * One clip
 * ------------------------------------------------------------------ */

async function record(browser, anime, opts, rnd, hook, ending, workDir) {
  const theme = THEMES[opts.theme];
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme.scheme,
    reducedMotion: 'no-preference',
    recordVideo: {
      dir: workDir,
      size: { width: VIEWPORT.width * SCALE, height: VIEWPORT.height * SCALE },
    },
  });

  const page = await ctx.newPage();
  const t0 = Date.now();                       // the recording starts about here

  await page.addInitScript(overlayInit, {
    bg: theme.bg,
    addrH: ADDR_H,
    site: SITE_URL,
    poster: anime.image,
    kicker: hook[0],
    title: anime.title,
    hook: hook[1],
    ending,
    font: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  });

  const wait = (ms) => page.waitForTimeout(ms);
  const pick = (range) => between(rnd, range);

  // The catalogue is what everything else waits on, and it is 1.3 MB. Load it
  // behind the title card so the clip never contains the wait.
  const catalogueLoaded = page
    .waitForResponse((res) => res.url().includes('/anime.json'), { timeout: 30000 })
    .catch(() => null);
  await page.goto(`http://127.0.0.1:${opts.port}/`, { waitUntil: 'load' });
  await catalogueLoaded;
  await page.evaluate(() => window.__wx.ready());
  await page.waitForSelector('#search-input', { state: 'visible' });
  await page.evaluate((ms) => window.__wx.posterReady(ms), 8000);
  await wait(250);

  /* Everything above is setup and gets trimmed off. The clip starts here. */
  const tStart = Date.now();

  await wait(pick(T.titleHold));
  await page.evaluate((ms) => window.__wx.fadeTitle(ms), pick(T.titleFade));
  await wait(pick(T.beforeTap));

  // Tap the search box, then type into it.
  const box = page.locator('#search-box');
  const bb = await box.boundingBox();
  await page.evaluate(([x, y]) => window.__wx.tap(x, y), [bb.x + bb.width / 2, bb.y + bb.height / 2]);
  await wait(180);
  await page.locator('#search-input').click();
  await wait(220);

  /* page.type with a fixed delay is the documented way to do this; the delay
     is rolled per keystroke instead, because a perfectly even cadence is the
     one thing that reads as a machine rather than a person. */
  const typed = [...anime.title];
  let index = 0;
  const typeOne = async () => {
    await page.keyboard.type(typed[index]);
    index += 1;
    await wait(pick(T.perChar));
  };
  while (index < Math.min(typed.length, 30)) await typeOne();

  await page.waitForSelector('#suggestions .suggestion', { timeout: 15000 });
  await wait(pick(T.afterType));

  /* Keep typing if the one we want is not on the list yet — which is what a
     person does, and what a 60-character title needs. */
  let hit = await page.evaluate((t) => window.__wx.suggestionIndex(t), anime.title);
  while (hit < 0 && index < typed.length) {
    await typeOne();
    await wait(160);
    hit = await page.evaluate((t) => window.__wx.suggestionIndex(t), anime.title);
  }
  if (hit < 0) hit = 0;

  const row = page.locator('#suggestions .suggestion').nth(hit);
  const rb = await row.boundingBox();
  await page.evaluate(([x, y]) => window.__wx.tap(x, y), [rb.x + rb.width / 2, rb.y + rb.height / 2]);
  await wait(180);
  await row.click();

  await page.waitForSelector('.hero', { timeout: 20000 });
  await page.evaluate((ms) => window.__wx.cardSettled(ms), 9000);
  await wait(pick(T.afterPick));

  const shown = await page.evaluate(() => (
    document.querySelector('.hero h2')?.textContent?.trim() || ''
  ));

  await wait(pick(T.holdTop));
  const target = await page.evaluate(() => window.__wx.scrollTargetForCard());
  await page.evaluate(([to, ms]) => window.__wx.scrollTo(to, ms), [target, pick(T.scrollDur)]);
  await wait(pick(T.holdBottom));

  await page.evaluate((ms) => window.__wx.fadeEnd(ms), pick(T.endFade));
  await wait(pick(T.endHold));

  const tStop = Date.now();
  const videoPath = await page.video().path();
  await ctx.close();

  return {
    videoPath,
    trim: Math.max(0, (tStart - t0) / 1000 - 0.2),
    duration: (tStop - tStart) / 1000 + 0.35,
    shown,
  };
}

/* ------------------------------------------------------------------ *
 * WebM -> MP4
 * ------------------------------------------------------------------ */

function run(bin, args, opts = {}) {
  return new Promise((resolve_, reject) => {
    execFile(bin, args, { maxBuffer: 1 << 26, ...opts }, (err, out, stderr) => {
      if (err) reject(new Error((stderr && stderr.toString().slice(-1500)) || err.message));
      else resolve_(out);
    });
  });
}

/* The sides of the frame.
 *
 * A 390x844 phone is 9:19.5 and TikTok wants 9:16, so 96 pixels each side have
 * to come from somewhere. Filling them with the background hex from styles.css
 * left a visible band down both edges: the recording is VP8, so #17181a comes
 * back through the decoder as #151619, and a fill drawn at the nominal value
 * sits a step off it in every channel. Sampling the real colour out of the
 * video fixed the join at the start of the clip and not at the end, because
 * the flat background drifts by a step or so between keyframes.
 *
 * fillborders in smear mode copies the outermost column of the picture
 * outwards instead, per frame, so the join matches whatever the decoder
 * actually produced at that moment and cannot drift. The page has 20px of
 * padding either side, so that outermost column is always flat background and
 * never part of a poster or a banner.
 */
const FIT_W = 2 * Math.round((VIEWPORT.width * SCALE * OUT.height) / (VIEWPORT.height * SCALE) / 2);
const SIDE = (OUT.width - FIT_W) / 2;

async function toMp4(webm, mp4, { trim, duration }) {
  const filters = [
    `scale=${FIT_W}:${OUT.height}:flags=lanczos`,
    `pad=${OUT.width}:${OUT.height}:${SIDE}:0`,
    `fillborders=left=${SIDE}:right=${SIDE}:mode=smear`,
    'setsar=1',
    'fps=30',
    'format=yuv420p',
  ].join(',');

  await run(ffmpegPath, [
    '-y',
    '-i', webm,
    // After -i, so the seek is frame-accurate rather than to the nearest
    // keyframe — the trim lands on the title card either way, but a keyframe
    // seek on a 16-second clip can be a second out.
    '-ss', trim.toFixed(3),
    '-t', duration.toFixed(3),
    '-vf', filters,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-profile:v', 'high',
    '-level', '4.0',
    '-movflags', '+faststart',
    '-an',                       // no audio, deliberately — see the header
    mp4,
  ]);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const catalogue = loadCatalogue();

  const targets = [];
  for (const wanted of opts.wanted) {
    const found = resolve(catalogue, wanted);
    if (!found) { console.warn(`  ! "${wanted}" is not in the catalogue — skipped.`); continue; }
    if (!found.genres.length) {
      console.warn(`  ! "${found.title}" has no genres, so the site cannot match on it — skipped.`);
      continue;
    }
    targets.push(found);
  }
  if (!targets.length) throw new Error('Nothing left to record.');

  console.log(`${targets.length} clip${targets.length === 1 ? '' : 's'}, ${opts.theme} theme:`);
  for (const a of targets) console.log(`  ${String(a.id).padStart(6)}  ${a.title}`);
  if (opts.dry) return;

  const seed = opts.seed ?? (Date.now() & 0x7fffffff);
  const rnd = mulberry32(seed);
  const nextHook = dealer(HOOKS, rnd);
  const nextEnding = dealer(ENDINGS, rnd);
  console.log(`Seed ${seed} — pass --seed ${seed} to reproduce this batch.\n`);

  fs.mkdirSync(opts.out, { recursive: true });
  const workDir = path.join(opts.out, '.webm');
  fs.mkdirSync(workDir, { recursive: true });

  const server = await ensureServer(opts.port);
  const browser = await chromium.launch({
    // Not optional. Playwright records at CSS-pixel size, so without this the
    // capture is 390 wide and every upscale to 1080 is mush.
    args: [`--force-device-scale-factor=${SCALE}`, '--hide-scrollbars'],
  });

  const made = [];
  const failed = [];
  try {
    for (const [i, anime] of targets.entries()) {
      const label = `[${i + 1}/${targets.length}] ${anime.title}`;
      process.stdout.write(`${label}\n`);
      const hook = nextHook();
      const ending = nextEnding();

      let result;
      try {
        result = await record(browser, anime, opts, rnd, hook, ending, workDir);
      } catch (err) {
        console.error(`        ! ${anime.title} failed: ${err.message.split('\n')[0]}\n`);
        failed.push(anime.title);
        continue;
      }
      const name = `${slugify(anime.title)}--${slugify(result.shown) || 'result'}.mp4`;
      const mp4 = path.join(opts.out, name);
      await toMp4(result.videoPath, mp4, {
        trim: result.trim,
        duration: result.duration,
      });
      if (!opts.keepWebm) fs.rmSync(result.videoPath, { force: true });

      const size = (fs.statSync(mp4).size / 1e6).toFixed(1);
      console.log(`        -> ${result.shown}`);
      console.log(`        -> ${path.relative(ROOT, mp4)}  ${result.duration.toFixed(1)}s, ${size} MB`);
      console.log(`        -> hook: "${hook[0]} … ${hook[1]}"\n`);
      made.push(mp4);
    }
  } finally {
    await browser.close();
    stopServer(server);
    if (!opts.keepWebm) fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (failed.length) console.log(`Failed: ${failed.join(', ')}`);
  console.log(`Done. ${made.length} file${made.length === 1 ? '' : 's'} in ${path.relative(ROOT, opts.out)}/`);
  console.log('No audio, by design — pick a trending sound in the TikTok editor.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
