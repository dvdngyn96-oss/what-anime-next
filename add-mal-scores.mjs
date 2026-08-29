/**
 * add-mal-scores.mjs — harvest MyAnimeList score histograms into the catalogue.
 *
 *   node add-mal-scores.mjs            # fetch, then merge into anime.json
 *   node add-mal-scores.mjs --fetch    # fetch only, to mal-scores.jsonl
 *   node add-mal-scores.mjs --merge    # merge what has already been fetched
 *
 * **Why a histogram and not a score.** MyAnimeList's own `mean` is available
 * on the official API and the catalogue already carries it. What it cannot
 * give is the *shape*: whether 8.9 came from broad agreement or from a
 * love-it-or-hate-it split. The shape is what turns a mean into "would
 * recommend", which is the figure the ratings row exists to show.
 *
 * **Why Tenrai.** MyAnimeList's official API exposes the status breakdown
 * (watching/completed/dropped, already stored as `stats`) but not the score
 * distribution — verified by asking for it under every plausible field name
 * and getting silently ignored. Tenrai is an unofficial REST mirror that does
 * expose it, at `/v1/anime/<id>/statistics`. Its status counts match what the
 * official API already gave us digit for digit, so it is the same underlying
 * data rather than a divergent set.
 *
 * **The dependency risk is bounded by this being build-time.** Tenrai is a
 * community project and could disappear. The numbers are baked into
 * anime.json, so if it does, the site keeps serving the last snapshot and
 * nothing breaks — the same shape of dependency as the catalogue itself.
 *
 * Appends one JSON line per entry to mal-scores.jsonl and skips anything
 * already there, so an interrupted run resumes rather than restarting.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';

const OUT = 'mal-scores.jsonl';
const API = 'https://api.tenrai.org/v1/anime';

/* Measured at about 5 requests a second before a 429, so this sits just under
   it. 4,400 entries is roughly 18 minutes — affordable against a 100-minute
   rebuild, and the reason this is worth doing at all. */
const DELAY = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv.includes('--merge') ? 'merge'
  : process.argv.includes('--fetch') ? 'fetch' : 'both';

async function fetchAll() {
  const catalogue = JSON.parse(readFileSync('anime.json', 'utf8'));
  const done = new Set();
  if (existsSync(OUT)) {
    for (const line of readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).i); } catch { /* half-written last line */ }
    }
    console.log(`resuming: ${done.size} already fetched`);
  }

  const todo = catalogue.anime.filter((a) => !done.has(a.i));
  console.log(`${todo.length} to fetch, about ${Math.ceil(todo.length * DELAY / 60000)} minutes\n`);

  let ok = 0; let missing = 0; let failed = 0;
  for (let n = 0; n < todo.length; n++) {
    const anime = todo[n];
    let row = null;

    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      try {
        const res = await fetch(`${API}/${anime.i}/statistics`);
        if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
        if (res.status === 404) { row = { i: anime.i, s: null }; break; }
        if (!res.ok) { await sleep(800 * (attempt + 1)); continue; }
        const body = await res.json();
        const scores = body?.data?.scores;
        if (!Array.isArray(scores) || scores.length !== 10) { row = { i: anime.i, s: null }; break; }
        /* Ten counts, lowest score first, so the array index is the score
           minus one and nothing has to be looked up by key. */
        const counts = Array.from({ length: 10 }, (_, k) =>
          scores.find((x) => x.score === k + 1)?.votes || 0);
        row = { i: anime.i, s: counts };
      } catch {
        await sleep(800 * (attempt + 1));
      }
    }

    if (!row) { row = { i: anime.i, s: null }; failed += 1; }
    else if (row.s) ok += 1;
    else missing += 1;

    appendFileSync(OUT, JSON.stringify(row) + '\n');
    if ((n + 1) % 100 === 0 || n === todo.length - 1) {
      process.stdout.write(`\r  ${n + 1}/${todo.length} — ${ok} with scores, ${missing} without, ${failed} failed`);
    }
    await sleep(DELAY);
  }
  console.log('\n');
}

function merge() {
  const catalogue = JSON.parse(readFileSync('anime.json', 'utf8'));
  const rows = new Map();
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); rows.set(j.i, j.s); } catch { /* skip */ }
  }

  let added = 0; let blank = 0;
  for (const anime of catalogue.anime) {
    const counts = rows.get(anime.i);
    if (!counts) { delete anime.sd; blank += 1; continue; }
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) { delete anime.sd; blank += 1; continue; }

    /* Stored as tenths of a percent, plus the true total.
     *
     * The raw counts run to six digits each and would add about 20% to the
     * catalogue every visitor downloads. Shares cost a third of that and keep
     * the only property that matters: **the shape is preserved, so the
     * threshold stays a read-time decision.** Storing a computed "% would
     * recommend" instead would save more still and is exactly the mistake
     * schema.sql already warns against — a stored verdict can only be retuned
     * by asking everyone again. */
    const shares = counts.map((c) => Math.round((c / total) * 1000));
    anime.sd = shares;
    anime.sv = total;
    added += 1;
  }

  const tmp = 'anime.json.tmp';
  writeFileSync(tmp, JSON.stringify(catalogue));
  renameSync(tmp, 'anime.json');   // atomic: a plain write died once on Windows
  console.log(`merged: ${added} with a distribution, ${blank} without`);
  console.log(`catalogue is now ${(Buffer.byteLength(JSON.stringify(catalogue)) / 1048576).toFixed(2)} MB`);
}

if (mode !== 'merge') await fetchAll();
if (mode !== 'fetch') merge();
