import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Derived from this file's own location rather than hard-coded, so the suite
   runs from any checkout and any working directory -- and so the repo, which
   Cloudflare serves publicly from the Pages root, carries nobody's home
   directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1);
const html = readFileSync(`${ROOT}/index.html`, 'utf8').replace(/<script src="app\.js[^"]*"><\/script>/, '');
const appSource = readFileSync(`${ROOT}/app.js`, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  <-- ${detail}`}`);
  if (!ok) failures++;
}

/* ---------- synthetic catalogue: precise logic assertions ---------- */

const G = ['Action', 'Fantasy', 'Romance', 'Comedy', 'School'];
const row = (r, i, t, s, g, extra = {}) => ({ r, i, t, s, g, th: [4], ty: 'TV', e: 12, y: 2013, m: 100000, im: 'x/y.jpg', ...extra });

const SYNTHETIC = {
  built: '2026-07-25', count: 8, names: G,
  anime: [
    row(1, 100, 'Great Action Fantasy Romance', 9.0, [0, 1, 2]),
    row(2, 101, 'Only Comedy', 8.9, [3]),
    row(3, 102, 'Action Fantasy Only', 8.8, [0, 1]),
    row(4, 103, 'Unrelated Music Thing', 8.7, [0, 1, 2], { ty: 'Music' }),
    row(5, 104, 'Nearer Action Fantasy Romance', 8.5, [0, 1, 2]),
    row(6, 105, 'Source Show: Second Season', 8.4, [0, 1, 2]),
    row(7, 106, 'Source Show', 8.3, [0, 1, 2]),
    row(8, 107, 'Below Exact', 8.2, [0, 1, 2]),
  ],
};

const ANILIST_HIT = {
  data: { Page: { media: [{
    idMal: 999, title: { romaji: 'Obscure Deep Cut', english: null }, averageScore: 60,
    popularity: 5000, genres: ['Action', 'Fantasy', 'Romance'], episodes: 12,
    seasonYear: 2011, format: 'TV', coverImage: { large: 'c.jpg' }, description: 'A deep cut.',
  }] } },
};

function makeDom(catalogue, { url = 'https://example.com/', anilist = ANILIST_HIT, detail = null, ratings = null, onVote = null, seedWatched = null, seedModern = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url, pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  /* Seeded before the script boots, because app.js reads both of these
     into module scope on load -- setting them afterwards leaves the page
     running on the defaults and quietly passes tests that should fail. */
  if (seedWatched) dom.window.localStorage.setItem('wanx:watched:v1', JSON.stringify(seedWatched));
  if (seedModern != null) dom.window.localStorage.setItem('wanx:modern', seedModern ? '1' : '0');
  dom.window.fetch = (target, options) => {
    const href = String(target);
    /* The vote endpoints. Absent unless a test asks for them, so every other
       test exercises the path where ratings are simply unavailable -- which is
       the state the live site is in for any title nobody has rated. */
    if (href.includes('api/ratings')) {
      if (!ratings) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ratings) });
    }
    if (href.includes('api/vote')) {
      if (onVote) onVote(JSON.parse(options?.body || '{}'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ recorded: 1 }) });
    }
    if (String(target).includes('anilist')) {
      // The per-title lookup (synopsis + trailer) and the search share a host,
      // so tell them apart by which query went out.
      const body = String(options?.body ?? '');
      const payload = body.includes('trailer') && detail ? detail : anilist;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalogue) });
  };
  // Top-level let/const are lexical bindings, invisible to an eval from
  // outside, so hand out an accessor from inside the same script.
  dom.window.eval(`${appSource}\nwindow.__ranked = () => ranked;
window.__signatureThemes = () => [...signatureThemes];
window.__collectTiers = collectTiers;
window.__positionOf = positionOf;
window.__lengthOf = lengthOf;
window.__parseExport = parseExport;
window.__readListRows = readListRows;
window.__malVerdict = malVerdict;
window.__recommendText = recommendText;
window.__recommendFigure = recommendFigure;`);
  return dom;
}

async function pickAndRecommend(dom, query) {
  const w = dom.window;
  const input = w.document.getElementById('search-input');
  input.value = query;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(500);
  const first = w.document.querySelector('#suggestions .suggestion');
  if (!first) return null;
  first.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  await sleep(300);
  return w.document.getElementById('result-body');
}

console.log('--- synthetic catalogue ---');
{
  const dom = makeDom(SYNTHETIC);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w = dom.window;
  const txt = () => body.textContent.replace(/\s+/g, ' ');
  const hero = body.querySelector('.hero h2')?.textContent;

  check('local search finds the source', !!body, 'no suggestion rendered');
  check('walks to the NEXT entry up the rankings', hero === 'Nearer Action Fantasy Romance', hero);
  check('skips same-franchise sequel', !txt().includes('Second Season'));
  check('skips Music type', !txt().includes('Unrelated Music Thing'));
  check('skips partial match while exact exist', !txt().includes('Action Fantasy Only'));
  check('lists the further exact match', txt().includes('Great Action Fantasy Romance'));
  check('reports the rank distance climbed', txt().includes('2 places higher'), txt().slice(0, 200));
  check('attributes the source', txt().includes('Because you watched Source Show'));
  /* Results live at /anime/<id>/<slug> now rather than /?id=N — one real
     document each, so a crawler has something to index and the slug carries
     the words somebody actually searched. */
  check('URL is shareable', w.location.pathname === '/anime/106/source-show/',
    w.location.pathname + w.location.search);

  // direction: down
  body.querySelector('[data-action="direction"][data-value="down"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('direction down walks the other way',
    body.querySelector('.hero h2')?.textContent === 'Below Exact',
    body.querySelector('.hero h2')?.textContent);
}

console.log('\n--- top-of-rankings fallback ---');
{
  // "Great Action Fantasy Romance" is rank #1 — nothing above it to climb to.
  const dom = makeDom(SYNTHETIC);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Great Action Fantasy Romance');
  const txt = body.textContent.replace(/\s+/g, ' ');
  const hero = body.querySelector('.hero h2')?.textContent;

  check('a #1-ranked anime still gets a recommendation', !!hero, 'dead end');
  check('it turns around and walks down', hero === 'Nearer Action Fantasy Romance', hero);
  check('and explains why', /walks down instead/.test(txt), txt.slice(0, 220));
  check('distance label says "lower"', txt.includes('places lower'), txt.slice(0, 220));
}

console.log('\n--- match quality beats direction ---');
{
  // Above the source: only a weak 1-of-3 match. Below it: a full match.
  // The full match should win even though it means walking the other way.
  const QUALITY = {
    built: '2026-07-25', count: 3, names: G,
    anime: [
      row(1, 200, 'Weak Match Above', 9.0, [0, 3]),
      row(2, 201, 'The Source Show', 8.5, [0, 1, 2]),
      row(3, 202, 'Strong Match Below', 8.0, [0, 1, 2]),
    ],
  };
  const dom = makeDom(QUALITY);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'The Source Show');
  const txt = body.textContent.replace(/\s+/g, ' ');
  const hero = body.querySelector('.hero h2')?.textContent;

  check('prefers a full genre match downward over a weak one upward',
    hero === 'Strong Match Below', hero);
  check('does not serve the weak upward match', !txt.includes('Weak Match Above'));
  check('explains the turnaround', txt.includes('walks down instead'), txt.slice(0, 200));
  check('reports it as an exact match, not a partial one',
    !txt.includes('all but one') && !txt.includes('partial'), txt.slice(0, 200));
}

console.log('\n--- pivot chains do not loop ---');
{
  // Three mutually-matching shows. Pivoting must move through them, not
  // bounce between the nearest pair forever.
  const CHAIN = {
    built: '2026-07-25', count: 3, names: G,
    anime: [
      row(1, 300, 'Alpha Show', 9.0, [0, 1, 2]),
      row(2, 301, 'Beta Show', 8.5, [0, 1, 2]),
      row(3, 302, 'Gamma Show', 8.0, [0, 1, 2]),
    ],
  };
  const dom = makeDom(CHAIN);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Beta Show');
  const w = dom.window;

  const shown = [];
  const anchors = [];
  for (let i = 0; i < 2; i++) {
    shown.push(body.querySelector('.hero h2')?.textContent);
    anchors.push(/Because you watched (.+?) —/.exec(body.textContent.replace(/\s+/g, ' '))?.[1]);
    if (i === 1) break;                       // leave the last one on screen
    body.querySelector('.hero [data-action="seen"]')
      ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(150);
  }

  check('first result climbs to the better-ranked show', shown[0] === 'Alpha Show', shown.join(' -> '));
  check('dismissing it does not bounce back to the source', shown[1] !== 'Beta Show', shown.join(' -> '));
  check('it offers the remaining show instead', shown[1] === 'Gamma Show', shown.join(' -> '));
  check('the anchor never changes', anchors.every((a) => a === 'Beta Show'), anchors.join(' | '));

  // "Start from this instead" is the explicit way to re-anchor.
  const reanchor = body.querySelector('.hero [data-action="anchor"]');
  reanchor.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('"start from this instead" re-anchors',
    /Because you watched Gamma Show/.test(body.textContent.replace(/\s+/g, ' ')),
    body.textContent.replace(/\s+/g, ' ').slice(0, 120));

  // "Seen it too" is taken at its word: it means it for good, not just for this
  // chain, so a fresh search must NOT bring the dismissed show back. Getting it
  // back is what the Clear button is for.
  const input = w.document.getElementById('search-input');
  const research = async () => {
    w.document.getElementById('home-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    input.value = 'Beta Show';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(400);
    w.document.querySelector('#suggestions .suggestion')?.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await sleep(200);
    return body.querySelector('.hero h2')?.textContent;
  };

  check('a show marked seen stays gone after a fresh search',
    (await research()) !== 'Alpha Show', body.querySelector('.hero h2')?.textContent);

  const stored = JSON.parse(w.localStorage.getItem('wanx:watched:v1') || '[]');
  check('marking it seen wrote it to the watched list', stored.length > 0, JSON.stringify(stored));

  w.document.getElementById('home-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  w.document.getElementById('clear-watched-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  check('clearing the watched list brings it back', (await research()) === 'Alpha Show',
    body.querySelector('.hero h2')?.textContent);
}

console.log('\n--- themes, status and hidden gems ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance', 'Comedy', 'School', 'Isekai'];
  const mk = (r, i, t, s, m, th, st) => ({
    r, i, t, s, m, th, st, g: [0, 1, 2], ty: 'TV', e: 12, y: 2013, im: 'x/y.jpg',
  });

  const FEAT = {
    built: '2026-07-25', count: 3, names: NAMES,
    anime: [
      // farther up the list, but shares the source's theme — and is obscure
      mk(1, 400, 'Far Theme Match', 9.0, 1000, [4], 'air'),
      // nearer, same genres, but no shared theme
      mk(2, 401, 'Near No Theme', 8.8, 500000, [5], 'fin'),
      mk(3, 402, 'Source Show', 8.5, 500000, [4], 'fin'),
    ],
  };

  const dom = makeDom(FEAT);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const hero = body.querySelector('.hero h2')?.textContent;
  const heroBadges = [...body.querySelectorAll('.hero .badge')].map((b) => b.textContent);
  const sharedTags = [...body.querySelectorAll('.hero .tag-shared')].map((t) => t.textContent);

  check('a shared theme outranks being nearer in the rankings',
    hero === 'Far Theme Match', hero);
  check('the shared theme is marked in the UI', sharedTags.includes('School'), sharedTags.join(', '));
  check('an unshared theme is not marked', !sharedTags.includes('Isekai'), sharedTags.join(', '));
  check('hidden gem is flagged', heroBadges.includes('Hidden gem'), heroBadges.join(', '));
  check('currently airing is flagged', heroBadges.includes('Currently airing'), heroBadges.join(', '));

  // Running out of theme matches sends the walk back to the source to climb
  // again. That jump must be explained, not just happen.
  const w2 = dom.window;
  body.querySelector('.hero [data-action="shuffle"]')
    ?.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const afterTxt = body.textContent.replace(/\s+/g, ' ');
  check('dropping the theme match is explained',
    /share the School theme/.test(afterTxt) && /widened to genre matches only/.test(afterTxt),
    afterTxt.slice(0, 240));
  check('the widening itself is explained',
    /widened to genre matches only/.test(afterTxt), afterTxt.slice(0, 240));

  // back to the first result for the remaining checks
  body.querySelector('.hero [data-action="shuffle"]')
    ?.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  await sleep(120);

  // The famous, well-watched entry must not be called a gem.
  const nearCard = [...body.querySelectorAll('.mini-card')]
    .find((el) => el.textContent.includes('Near No Theme'));
  check('a widely-watched show is not a gem',
    !nearCard || !nearCard.textContent.includes('Hidden gem'), nearCard?.textContent);
}

console.log('\n--- demographic ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance', 'School', 'Shounen', 'Josei'];
  const mk = (r, i, t, s, th, d) => ({
    r, i, t, s, th, d, g: [0, 1, 2], ty: 'TV', e: 12, y: 2013, m: 200000, im: 'x/y.jpg', st: 'fin',
  });

  // Source is Shounen + School. Two candidates share the theme; only one
  // shares the demographic, and it sits further away.
  const DEMO = {
    built: '2026-07-25', count: 4, names: NAMES,
    anime: [
      mk(1, 500, 'Far Same Demographic', 9.0, [3], [4]),   // School + Shounen
      mk(2, 501, 'Near Other Demographic', 8.8, [3], [5]), // School + Josei
      mk(3, 502, 'Near No Demographic', 8.7, [3], []),     // School, none
      mk(4, 503, 'Source Show', 8.5, [3], [4]),            // School + Shounen
    ],
  };

  const dom = makeDom(DEMO);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const hero = body.querySelector('.hero h2')?.textContent;
  const heroTags = [...body.querySelectorAll('.hero .tag')].map((t) => t.textContent);

  check('a matching demographic outweighs a nearer non-match',
    hero === 'Far Same Demographic', hero);
  check('the demographic is shown as its own tag', heroTags.includes('Shounen'), heroTags.join(', '));
  check('a matching demographic is marked as shared',
    [...body.querySelectorAll('.hero .tag-demo.tag-shared')].length === 1,
    heroTags.join(', '));

  // Absence must be neutral, never a penalty: the entry with no demographic
  // must still outrank the one that declares a conflicting demographic.
  const order = [];
  for (let i = 0; i < 3; i++) {
    order.push(body.querySelector('.hero h2')?.textContent);
    body.querySelector('.hero [data-action="shuffle"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  }
  check('a missing demographic is not penalised',
    order.indexOf('Near No Demographic') !== -1
      && order.indexOf('Near No Demographic') < order.indexOf('Near Other Demographic'),
    order.join(' -> '));

  // A source with no demographic at all must behave exactly as before.
  const NO_DEMO = {
    ...DEMO,
    anime: DEMO.anime.map((a) => (a.i === 503 ? { ...a, d: [] } : a)),
  };
  const dom2 = makeDom(NO_DEMO);
  await sleep(200);
  const body2 = await pickAndRecommend(dom2, 'Source Show');
  // With no demographic to match on, affinity ties and plain rank order wins —
  // so the nearest entry up the list is chosen, demographics ignored.
  check('a source without a demographic falls back to pure rank order',
    body2.querySelector('.hero h2')?.textContent === 'Near No Demographic',
    body2.querySelector('.hero h2')?.textContent);
}

console.log('\n--- completion metric ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, st, stats) => ({
    r, i, t, st, stats, s: 8, g: [0, 1, 2], th: [], d: [],
    ty: 'TV', e: 12, y: 2013, m: 200000, im: 'x/y.jpg',
  });

  const COMP = {
    built: '2026-07-25', count: 4, names: NAMES,
    anime: [
      mk(1, 600, 'Finished Popular', 'fin', { w: 100, c: 9000, h: 500, d: 500, p: 100 }),
      mk(2, 601, 'Still Airing', 'air', { w: 50000, c: 0, h: 100, d: 200, p: 9000 }),
      mk(3, 602, 'Barely Watched', 'fin', { w: 5, c: 40, h: 2, d: 3, p: 10 }),
      mk(4, 603, 'Source Show', 'fin', { w: 100, c: 5000, h: 100, d: 400, p: 100 }),
    ],
  };

  const dom = makeDom(COMP);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w4 = dom.window;
  const statsOf = () => [...body.querySelectorAll('.hero .stats div')].map((d) => d.textContent.trim());

  // Walking up from #4 hits #3 (too few viewers), then #2 (airing), then #1.
  const seen = [];
  for (let i = 0; i < 3; i++) {
    seen.push({ title: body.querySelector('.hero h2')?.textContent, stats: statsOf() });
    body.querySelector('.hero [data-action="shuffle"]')
      ?.dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  }

  const airing = seen.find((s) => s.title === 'Still Airing');
  const popular = seen.find((s) => s.title === 'Finished Popular');
  const barely = seen.find((s) => s.title === 'Barely Watched');

  check('a finished show reports its completion rate',
    popular && popular.stats.some((s) => s === '90%finished it'), JSON.stringify(popular?.stats));
  check('an airing show is excluded, not shown as 0%',
    airing && !airing.stats.some((s) => /%finished/.test(s)), JSON.stringify(airing?.stats));
  check('an airing show says why instead',
    airing && airing.stats.some((s) => /still airing/.test(s)), JSON.stringify(airing?.stats));
  check('a barely-watched show reports nothing rather than noise',
    barely && !barely.stats.some((s) => /%finished/.test(s)), JSON.stringify(barely?.stats));
}

console.log('\n--- proximity beats distant affinity ---');
{
  // A perfect thematic match sitting far down the list must not leapfrog a
  // near neighbour that shares the genres. This is the Fullmetal Alchemist:
  // Brotherhood -> Arslan Senki case: 1,592 places away beat 105 away.
  const NAMES = ['Action', 'Fantasy', 'Military', 'Shounen'];
  const mk = (r, i, t, th, d, g = [0, 1]) => ({
    r, i, t, th, d, s: 8, g, ty: 'TV', e: 24, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  /* The distant match has to be *genuinely* distant.
   *
   * This fixture used to be eight entries, with the perfect match seven places
   * down. That was a fair stand-in while the affinity window was measured in
   * bucket slots — seven slots was outside a window of five. The window is
   * measured in ranking positions now, and seven positions is a near
   * neighbour by any reading, so the short fixture stopped modelling the case
   * it names. Distance here goes through positionOf, which returns rankPos —
   * an ordinal over the catalogue — so the only way to be 200 places away is
   * to have 200 entries in between.
   *
   * The filler carries **no genres**, so it never enters the candidate bucket
   * and cannot be what holds the distant match back. Give the filler genres
   * instead and MAX_LOOKAHEAD does the blocking, which makes the test pass
   * for the wrong reason — verified by raising AFFINITY_REACH to 1000 and
   * watching it stay green.
   */
  const anime = [
    mk(1, 800, 'Source Show', [2], [3]),            // Military + Shounen
    mk(2, 801, 'Near Neighbour', [], []),           // genres only, 1 place away
    mk(3, 802, 'Filler A', [], []),                 // genre matches, near
    mk(4, 803, 'Filler B', [], []),
    mk(5, 804, 'Filler C', [], []),
    mk(6, 805, 'Filler D', [], []),
    mk(7, 806, 'Filler E', [], []),
  ];
  // Spacing only — no genres, so these never become candidates.
  for (let n = 0; n < 200; n++) anime.push(mk(8 + n, 807 + n, `Gap ${n}`, [], [], []));
  anime.push(mk(208, 1007, 'Distant Perfect Match', [2], [3]));   // 207 places away

  const NEAR = { built: '2026-07-25', count: anime.length, names: NAMES, anime };

  const dom = makeDom(NEAR);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w6 = dom.window;
  body.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await sleep(200);

  const order = [];
  for (let i = 0; i < 3; i++) {
    order.push(body.querySelector('.hero h2')?.textContent);
    body.querySelector('.hero [data-action="shuffle"]')
      ?.dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
    await sleep(70);
  }

  check('a near neighbour beats a distant perfect match',
    order[0] === 'Near Neighbour', order.join(' -> '));
  check('the distant match is not pulled to the front',
    !order.slice(0, 2).includes('Distant Perfect Match'), order.join(' -> '));
}

console.log('\n--- the requested direction is exhausted first ---');
{
  // Two matches above, one of them out of monotonic order because affinity
  // pulled it forward, plus matches below. Every upward option must be offered
  // before the walk turns around.
  const NAMES = ['Action', 'Fantasy', 'Romance', 'School'];
  const mk = (r, i, t, th) => ({
    r, i, t, th, d: [], s: 8, g: [0, 1, 2], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const DIR = {
    built: '2026-07-25', count: 6, names: NAMES,
    anime: [
      mk(1, 950, 'Far Above Themed', [3]),   // affinity pulls this forward
      mk(2, 951, 'Above Plain A', []),
      mk(3, 952, 'Above Plain B', []),
      mk(4, 953, 'Source Show', [3]),
      mk(5, 954, 'Below A', []),
      mk(6, 955, 'Below B', []),
    ],
  };

  const dom = makeDom(DIR);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w8 = dom.window;

  const seen = [];
  for (let i = 0; i < 5; i++) {
    const t = body.querySelector('.hero h2')?.textContent;
    if (!t) break;
    seen.push(t);
    body.querySelector('.hero [data-action="shuffle"]')
      ?.dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
    await sleep(70);
  }

  const aboveTitles = ['Far Above Themed', 'Above Plain A', 'Above Plain B'];
  const firstBelow = seen.findIndex((t) => t.startsWith('Below'));
  const lastAbove = seen.reduce((acc, t, i) => (aboveTitles.includes(t) ? i : acc), -1);

  check('all three upward matches are offered', aboveTitles.every((t) => seen.includes(t)), seen.join(' -> '));
  check('nothing downward appears until upward is exhausted',
    firstBelow === -1 || firstBelow > lastAbove, seen.join(' -> '));
}

console.log('\n--- trailers ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 }, ...extra,
  });

  const CAT = {
    built: '2026-07-30', count: 2, names: NAMES,
    anime: [mk(1, 960, 'Has A Trailer', { bn: '960.jpg' }), mk(2, 961, 'Source Show')],
  };

  const WITH = { data: { Media: { description: 'A synopsis.', trailer: { id: 'abc123', site: 'youtube' } } } };
  const WITHOUT = { data: { Media: { description: 'A synopsis.', trailer: null } } };

  // with a trailer
  {
    const dom = makeDom(CAT, { detail: WITH });
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    await sleep(400);                      // the lookup is lazy
    const w = dom.window;

    const btn = body.querySelector('[data-action="trailer"]');
    check('a play button appears once a trailer is found', !!btn, body.querySelector('.hero-actions')?.textContent);

    btn?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(80);

    const frame = body.querySelector('iframe.hero-trailer');
    check('clicking it embeds the player', !!frame);
    check('it uses the privacy-preserving YouTube host',
      /youtube-nocookie\.com\/embed\/abc123/.test(frame?.getAttribute('src') || ''), frame?.getAttribute('src'));
    check('the player replaces the banner rather than stacking',
      !body.querySelector('.hero-banner'), 'banner still present');
    check('the card knows it is playing',
      body.querySelector('.hero')?.classList.contains('hero-playing'));
    // Hidden rather than removed: emptying the slot pulled the remaining
    // buttons leftwards the moment the video started. visibility:hidden is
    // unclickable and out of the tab order, so it is still not on offer.
    check('the button is consumed once used',
      body.querySelector('[data-action="trailer"]')?.classList.contains('btn-reserved'),
      body.querySelector('[data-action="trailer"]')?.className);
  }

  // without one
  {
    const dom = makeDom(CAT, { detail: WITHOUT });
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    await sleep(400);
    // The slot is always rendered so the row keeps its width; what matters is
    // that nothing playable is offered.
    check('no button when the show has no trailer',
      body.querySelector('[data-action="trailer"]')?.classList.contains('btn-reserved'),
      body.querySelector('[data-action="trailer"]')?.className);
    check('nothing is embedded unasked',
      !body.querySelector('iframe'));
  }
}

console.log('\n--- where to watch ---');
{
  /* Streaming listings come from AniList now, on the same request that already
     fetches the synopsis, rather than from TMDB fields baked into the
     catalogue. So these drive the detail fetch, not the catalogue rows. */
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const CAT = {
    built: '2026-07-30', count: 2, names: NAMES,
    anime: [mk(1, 970, 'Streams In Places'), mk(2, 972, 'Source Show')],
  };

  const withLinks = {
    data: { Media: { description: 'A show.', trailer: null, externalLinks: [
      { site: 'Official Site', url: 'https://x.jp/', type: 'INFO' },
      { site: 'Crunchyroll', url: 'https://crunchyroll.com/x', type: 'STREAMING' },
      { site: 'Netflix', url: 'https://netflix.com/x', type: 'STREAMING' },
      // A title can carry the same service twice; it should be listed once.
      { site: 'Netflix', url: 'https://netflix.com/x2', type: 'STREAMING' },
      { site: 'Twitter', url: 'https://x.com/x', type: 'SOCIAL' },
    ] } },
  };

  const dom = makeDom(CAT, { detail: withLinks });
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  await sleep(600);   // the detail fetch is debounced by 220ms

  const services = () => [...body.querySelectorAll('.watch .service')].map((x) => x.textContent);

  check('streaming services are listed from AniList',
    services().includes('Crunchyroll') && services().includes('Netflix'), services().join(', '));
  check('and only the streaming links, not the social or info ones',
    !services().includes('Twitter') && !services().includes('Official Site'), services().join(', '));
  check('a service appearing twice is listed once',
    services().filter((x) => x === 'Netflix').length === 1, services().join(', '));

  /* AniList gives the URL of the title on the service, which TMDB never did,
     so the chip is a real outbound link rather than a plain name. */
  const first = body.querySelector('.watch a.service');
  check('each service links straight to the title on it',
    first?.getAttribute('href') === 'https://crunchyroll.com/x', first?.outerHTML);
  check('and opens away from the page safely',
    first?.getAttribute('target') === '_blank' && /noopener/.test(first?.getAttribute('rel') || ''),
    first?.outerHTML);

  /* The row is a reserved single line because it now fills asynchronously.
     It used to come from the catalogue and could wrap freely; a row that grew
     when the request landed would shove every button below it. jsdom has no
     layout, so this reads the rule out of the stylesheet. */
  const css = readFileSync(`${ROOT}/styles.css`, 'utf8');
  const watchRule = /\.watch \{[^}]*\}/.exec(css)?.[0] ?? '';
  check('the row keeps a fixed height rather than growing when listings land',
    /height:\s*26px/.test(watchRule) && /flex-wrap:\s*nowrap/.test(watchRule), watchRule);

  // Nothing on record reads differently from "we could not ask".
  const none = { data: { Media: { description: 'A show.', trailer: null, externalLinks: [] } } };
  const dom2 = makeDom(CAT, { detail: none });
  await sleep(200);
  const body2 = await pickAndRecommend(dom2, 'Source Show');
  await sleep(600);
  check('a title with no listing says so rather than leaving the row blank',
    /No listing found/.test(body2.querySelector('.watch')?.textContent || ''),
    body2.querySelector('.watch')?.textContent);

  /* The region toggle went with TMDB: it existed only to pick which of TMDB's
     country listings to show, and AniList's links are not per-country. */
  check('the region toggle is gone',
    !body.querySelector('[data-action="region"]'), 'region button still present');
  check('and nothing writes a region to storage any more',
    dom.window.localStorage.getItem('wanx:region') === null,
    String(dom.window.localStorage.getItem('wanx:region')));

  /* No TMDB *call* survives in the shipped page — the credential is gone, so a
     leftover request would fail quietly. Matched on the API host and the key
     file rather than on the word, which still appears in the comments that
     explain why the dependency was dropped. */
  check('no TMDB request survives in app.js',
    !/themoviedb\.org|api\.themoviedb|\.tmdb-key/i.test(appSource), 'app.js still calls TMDB');
  /* And the real catalogue carries no provider fields: they were 76 KB that
     every visitor downloaded, and a leftover would be dead weight nothing
     reads. */
  const shipped = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  check('the shipped catalogue carries no TMDB fields any more',
    !('providers' in shipped) && !('watchUpdated' in shipped)
      && !shipped.anime.some((a) => 'tm' in a || 'wp' in a),
    `providers:${'providers' in shipped} rows:${shipped.anime.filter((a) => 'tm' in a || 'wp' in a).length}`);
}


console.log('\n--- key-art theming ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 }, ...extra,
  });

  const ART = {
    built: '2026-07-25', count: 4, names: NAMES,
    anime: [
      mk(1, 900, 'Colourful With Banner', { cl: 'e4bb50', bn: '900.jpg' }),
      mk(2, 901, 'Colour No Banner', { cl: '1a3a8f' }),
      mk(3, 902, 'Greyscale Cover', { cl: '888888' }),
      mk(4, 903, 'Source Show', { cl: 'ff4400', bn: '903.jpg' }),
    ],
  };

  const dom = makeDom(ART);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w7 = dom.window;
  const hero = () => body.querySelector('.hero');

  const advance = async () => {
    body.querySelector('.hero [data-action="shuffle"]')?.dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  };

  // Climbing from #4 reaches #3, #2, #1 in that order.
  check('greyscale artwork declines the tint instead of turning pink',
    hero()?.querySelector('h2')?.textContent === 'Greyscale Cover'
      && !(hero()?.getAttribute('style') || '').includes('--art:'),
    `${hero()?.querySelector('h2')?.textContent}: ${hero()?.getAttribute('style')}`);
  check('the card structure survives the banner wrapper',
    !!hero()?.querySelector('.hero-main .hero-body h2') && !!hero()?.querySelector('.hero-poster'));

  await advance();
  check('a show without a banner still gets its colour',
    /--art:#1a3a8f/.test(hero()?.getAttribute('style') || ''),
    hero()?.getAttribute('style'));

  /* Used to also assert the card did *not* carry hero-has-banner. That class
     is unconditional now: a third of entries have no banner image, and letting
     their cards be 150px shorter made the action buttons jump between results.
     What matters instead is that the strip is still there to hold the height,
     rendered from the show's own colour. */
  check('a show without a banner still reserves the strip',
    !!hero()?.querySelector('.hero-banner.hero-banner-blank')
      && hero()?.classList.contains('hero-has-banner'),
    hero()?.querySelector('.hero-banner')?.className);

  await advance();
  check('the card carries the cover colour as a custom property',
    /--art:#e4bb50/.test(hero()?.getAttribute('style') || ''), hero()?.getAttribute('style'));
  check('a banner renders when one exists',
    !!hero()?.querySelector('.hero-banner') && hero().classList.contains('hero-has-banner'));
  check('the banner points at the AniList CDN',
    /anilistcdn\/media\/anime\/banner\/900\.jpg/.test(hero()?.querySelector('.hero-banner')?.getAttribute('style') || ''));
  check('both light and dark tints are provided',
    /--art-on-dark:hsl/.test(hero()?.getAttribute('style') || '')
      && /--art-on-light:hsl/.test(hero()?.getAttribute('style') || ''));
}

console.log('\n--- ranking axis ---');
{
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, st, stats, e) => ({
    r, i, t, st, stats, e, s: 8, g: [0, 1, 2], th: [], d: [],
    ty: 'TV', y: 2013, m: 200000, im: 'x/y.jpg',
  });

  // Ranked worse by MAL, but far more people finish it.
  const AXIS = {
    built: '2026-07-25', count: 3, names: NAMES,
    anime: [
      mk(1, 700, 'High Rank Low Completion', 'fin', { w: 10, c: 5000, h: 100, d: 4000, p: 10 }, 12),
      mk(2, 701, 'Source Show', 'fin', { w: 10, c: 8000, h: 100, d: 1000, p: 10 }, 12),
      mk(3, 702, 'Low Rank High Completion', 'fin', { w: 10, c: 9800, h: 50, d: 150, p: 10 }, 12),
    ],
  };

  const dom = makeDom(AXIS);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w5 = dom.window;

  check('MAL rank is the default axis',
    body.querySelector('.hero h2')?.textContent === 'High Rank Low Completion',
    body.querySelector('.hero h2')?.textContent);

  body.querySelector('[data-action="axis"][data-value="completion"]')
    ?.dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await sleep(200);

  check('switching axis climbs the completion ranking instead',
    body.querySelector('.hero h2')?.textContent === 'Low Rank High Completion',
    body.querySelector('.hero h2')?.textContent);
  check('the axis toggle reflects the choice',
    body.querySelector('[data-action="axis"][data-value="completion"]')?.getAttribute('aria-pressed') === 'true');
  check('the label says which ranking is being climbed',
    /for keeping people watching/.test(body.textContent), body.textContent.replace(/\s+/g, ' ').slice(0, 200));
}

console.log('\n--- live expansion beyond the catalogue ---');
{
  const dom = makeDom(SYNTHETIC);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Obscure Deep Cut');
  const w = dom.window;
  const hero = body?.querySelector('.hero h2')?.textContent;

  check('falls back to AniList for an unknown title', !!body && body.textContent.includes('Obscure Deep Cut'),
    body?.textContent?.slice(0, 160));
  check('live entry slots into the ranking by score and recommends upward',
    hero === 'Below Exact', hero);
  check('live entry persisted to localStorage',
    (w.localStorage.getItem('wanx:extras:v1') || '').includes('Obscure Deep Cut'));

  /* A live entry has no MAL rank, and the card used to compose its own
     "ranked" in front of whatever rankLabel returned -- which read "ranked not
     in the ranking" on exactly the entries that most need the sentence to make
     sense. rankLabel carries the whole phrase now. */
  const because = body?.querySelector('.because')?.textContent ?? '';
  check('an entry with no rank does not say "ranked not in the ranking"',
    !/ranked not in/i.test(because) && /not in the MyAnimeList rankings/.test(because),
    because.slice(0, 120));
}

console.log('\n--- deep link ---');
{
  const dom = makeDom(SYNTHETIC, { url: 'https://example.com/?id=106&dir=down' });
  await sleep(500);
  const body = dom.window.document.getElementById('result-body');
  check('deep link loads a result directly', body.textContent.includes('Because you watched Source Show'));
  check('deep link honours dir=down',
    body.querySelector('[data-action="direction"][data-value="down"]')?.getAttribute('aria-pressed') === 'true');
}

/* ---------- the real catalogue: the user's actual example ---------- */

console.log('\n--- REAL catalogue: Tokyo Ravens ---');
try {
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const dom = makeDom(real);
  await sleep(400);
  const body = await pickAndRecommend(dom, 'tokyo ravens');

  if (!body) {
    check('Tokyo Ravens found in catalogue', false, 'no suggestion');
  } else {
    const txt = body.textContent.replace(/\s+/g, ' ');
    const hero = body.querySelector('.hero h2')?.textContent;
    check('Tokyo Ravens found and attributed', txt.includes('Because you watched Tokyo Ravens'), txt.slice(0, 140));
    check('its genres are Action/Fantasy/Romance',
      ['Action', 'Fantasy', 'Romance'].every((g) => txt.includes(g)), txt.slice(0, 220));
    check('its MAL themes are shown too',
      txt.includes('School') && txt.includes('Urban Fantasy'), txt.slice(0, 220));
    // Ranks drift between rebuilds as MAL scores move, so assert the
    // neighbourhood rather than an exact figure.
    const shownRank = Number(/ranked #(\d+)/.exec(txt)?.[1]);
    check('rank is MAL\'s, around #2650',
      shownRank > 2500 && shownRank < 2800, `got #${shownRank}`);
    check('a recommendation was produced', !!hero, 'none');
    const heroGenres = [...body.querySelectorAll('.hero .tag')].map((t) => t.textContent);
    /* This used to demand all three genres, and that assertion encoded the old
       definition of match quality: shared genre count, full stop. Signature
       themes changed it deliberately — a show sharing Action, Fantasy and
       Tokyo Ravens' Urban Fantasy theme now outranks one sharing Action,
       Fantasy and the far broader Romance genre.
       So assert the rule that is actually in force rather than dropping the
       check: two of the three genres at minimum, and anything short of a full
       genre match has to be carrying a signature theme to be there at all. */
    const shareCount = ['Action', 'Fantasy', 'Romance'].filter((g) => heroGenres.includes(g)).length;
    check('recommendation shares at least two of the three genres',
      shareCount >= 2, heroGenres.join(', '));
    check('a less-than-full genre match earns its place with a signature theme',
      shareCount === 3 || ['Urban Fantasy', 'School'].some((t) => heroGenres.includes(t)),
      heroGenres.join(', '));

    /* Re-cuts, recaps and franchise extras that once shipped in the catalogue.
       Found by clicking through the live site: Overlord's chain reached
       "One Piece: Gyojin Tou-hen" -- MyAnimeList's own title for "One Piece
       Log: Fish-Man Island Saga", a 2024 re-broadcast condensing an arc into
       21 episodes.

       Checked by id rather than by title pattern, deliberately. `-hen` merely
       means "arc" and appears in Rurouni Kenshin: Tsuioku-hen at #72; "Saga"
       appears in Youjo Senki, Zombieland Saga and Excel Saga. A pattern here
       deletes real series, which is the Special A lesson restated.

       22 of these carry MyAnimeList's `full_story` relation, which points away
       at the complete work and so says outright that the entry is a
       condensation; the builder now drops those as a rule. The other five are
       filed under relations that legitimate standalone remakes also use, and
       are on a hand-curated denylist. */
    const RE_CUTS = [
      2449, 35321, 57469, 8756, 13931, 2125, 8423, 60820, 31105, 1111, 3483,
      2363, 1504, 1396, 1112, 23405, 17655, 12439, 14685, 1836, 7664, 36424,
      60108, 28069, 27957, 8857, 40323,
      // the twelve the full-catalogue sweep turned up after the first pass
      821, 8457, 3626, 3247, 30829, 760, 16033, 7559, 35519, 5136, 11101, 22215,
    ];
    const stillThere = real.anime.filter((a) => RE_CUTS.includes(a.i));
    check('catalogue holds no known re-cuts or franchise extras',
      stillThere.length === 0,
      `${stillThere.length}: ${stillThere.slice(0, 4).map((a) => a.t).join(' | ')}`);

    /* The four that look identical to the rule but must stay. `summary` points
       the *other* way -- it names the condensation of this entry, so carrying
       it marks the full work. Reading the two relations as equivalent would
       have deleted all four of these real series. */
    const KEEP_DESPITE_SUMMARY = [2829, 23587, 206, 36475];
    const wronglyGone = KEEP_DESPITE_SUMMARY.filter((id) => !real.anime.some((a) => a.i === id));
    check('the full works that merely have a summary are still here',
      wronglyGone.length === 0, `${wronglyGone.length} of 4 missing: ${wronglyGone.join(', ')}`);

    // catalogue-wide invariants: TV only, first seasons only
    const SEQUEL = [
      /\b(?:2nd|3rd|4th|5th|6th|7th|8th|9th|final)\s+season\b/i,
      /\bseason\s*[2-9]\b/i, /\bpart\s*[2-9]\b/i, /\b(?:ii|iii|iv)\s*$/i, /\bR2\b/,
    ];
    // TV plus standalone OVA/ONA — no films, specials or recaps.
    const badType = real.anime.filter((a) => !['TV', 'OVA', 'ONA'].includes(a.ty));
    const sequels = real.anime.filter((a) => SEQUEL.some((re) => re.test(a.t)));
    check('catalogue holds only startable formats',
      badType.length === 0, `${badType.length}: ${badType.slice(0, 3).map((a) => `${a.ty} ${a.t}`).join(', ')}`);
    check('catalogue has no obvious sequels', sequels.length === 0,
      `${sequels.length}: ${sequels.slice(0, 5).map((a) => a.t).join(' | ')}`);
    // Non-decreasing, not strictly increasing: MyAnimeList hands the same rank
    // to different titles (64 collisions in the top 8,000), so uniqueness is not
    // ours to enforce. The walk climbs rankPos — an ordinal built from this
    // order — which is why sortedness is the invariant that matters here.
    check('catalogue is ordered by rank',
      real.anime.every((a, i) => i === 0 || a.r >= real.anime[i - 1].r));

    // rankPos is what the walk actually climbs, so read it back off the running
    // app rather than recomputing it here — that way a renumbering bug shows up.
    const rankPositions = dom.window.__ranked().map((a) => a.rankPos);
    check('rank positions are a strict, gapless ordinal',
      rankPositions.length === real.anime.length
        && rankPositions.every((p, i) => p === i + 1),
      `${rankPositions.length} positions for ${real.anime.length} entries`);

    // Flipping through must climb steadily: each result better-ranked than the
    // last, with at most one labelled step back once the climb is exhausted.
    const w3 = dom.window;
    const steps = [];
    for (let i = 0; i < 18; i++) {
      const rank = Number(String(body.querySelector('.stats div:nth-child(2) b')?.textContent).replace('#', ''));
      const alt = body.querySelector('.hero .alt-title')?.textContent || '';
      const note = [...body.querySelectorAll('.note')].map((el) => el.textContent).join(' ');
      if (Number.isFinite(rank)) {
        steps.push({ rank, heading: /lower/.test(alt) ? 'down' : 'up', note });
      }
      body.querySelector('.hero [data-action="shuffle"]')
        ?.dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
      await sleep(60);
    }

    // Within a heading the rank must keep improving; a change of heading or a
    // step backwards is only acceptable if the page said why.
    const violations = [];
    const unexplained = [];
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const cur = steps[i];
      if (cur.heading !== prev.heading) {
        if (!/walks (up|down) instead|climb is exhausted/.test(cur.note)) unexplained.push(cur);
        continue;
      }
      const advanced = cur.heading === 'up' ? cur.rank < prev.rank : cur.rank > prev.rank;
      if (!advanced) {
        if (/climb is exhausted/.test(cur.note)) unexplained.push(...[]);
        else violations.push(`${prev.rank}->${cur.rank}`);
      }
    }

    check('flipping through keeps advancing, unexplained steps back',
      violations.length === 0, violations.join(', '));
    check('every change of heading is explained',
      unexplained.length === 0, unexplained.map((s) => s.note.slice(0, 80)).join(' | '));

    /* Notes sit *below* the card. They are conditional, and above the card
       their appearing and disappearing moved the card and every button in it
       between results — which happened precisely when the result had changed
       in a way worth reading about. */
    {
      const card = body.querySelector('.hero');
      const notes = [...body.querySelectorAll('.note')];
      const above = notes.filter((n) =>
        card && (card.compareDocumentPosition(n) & 2) === 2);   // 2 = PRECEDING
      check('explanatory notes sit below the card, never above it',
        notes.length > 0 && above.length === 0,
        `${notes.length} notes, ${above.length} above the card`);
    }

    // "Show me another" must keep producing new titles, not cycle a short list.
    const w2 = dom.window;
    const shuffled = [];
    for (let i = 0; i < 14; i++) {
      shuffled.push(body.querySelector('.hero h2')?.textContent);
      body.querySelector('.hero [data-action="shuffle"]')
        ?.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
      await sleep(60);
    }
    const dupes = shuffled.filter((t, i) => shuffled.indexOf(t) !== i);
    check('"show me another" does not cycle a short list',
      dupes.length === 0, `repeats: ${[...new Set(dupes)].join(', ')}`);
    check('every shuffled result is a real title',
      shuffled.every(Boolean), shuffled.join(' | '));
    console.log(`  >>> catalogue: ${real.count} TV first seasons, ranks #${real.anime[0].r}–#${real.anime.at(-1).r}`);
    console.log(`\n  >>> Tokyo Ravens leads to: "${hero}"`);
    console.log(`  >>> ${txt.slice(txt.indexOf('Because'), txt.indexOf('Because') + 130)}`);
  }
} catch (e) {
  check('real catalogue test', false, e.message);
}

console.log('\n--- genre-less entries match on themes, last ---');
{
  /* 31 catalogue entries have no genres at all, so they could never share one
   * and the walk could never reach them. They can still match on a theme, but
   * that is a weaker signal than a genre, so they sit in a tier below every
   * genre match rather than competing with them. */
  const NAMES = ['Action', 'Fantasy', 'Space'];
  const mk = (r, i, t, g, th) => ({
    r, i, t, g, th, d: [], ty: 'TV', s: 8, e: 12, y: 2020,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const cat = {
    built: '2026-08-19', count: 4, names: NAMES,
    anime: [
      mk(1, 500, 'Themed Source', [0, 1], [2]),      // Action+Fantasy, Space theme
      mk(2, 501, 'Genre Match', [0, 1], []),         // shares both genres
      mk(3, 502, 'Weak Genre Match', [0], []),       // shares one
      mk(4, 503, 'No Genres At All', [], [2]),       // no genres, shares the theme
    ],
  };

  const dom = makeDom(cat);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Themed Source');
  const w = dom.window;
  body.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);

  const seen = [];
  for (let i = 0; i < 3; i++) {
    seen.push(body.querySelector('.hero h2')?.textContent);
    body.querySelector('.hero [data-action="shuffle"]')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  }

  check('a genre-less entry is reachable at all',
    seen.includes('No Genres At All'), seen.join(' -> '));
  check('it comes after every genre match',
    seen.indexOf('No Genres At All') === seen.length - 1, seen.join(' -> '));
  // Cycle back round to it, so the note being read belongs to that card.
  for (let i = 0; i < 4 && body.querySelector('.hero h2')?.textContent !== 'No Genres At All'; i++) {
    body.querySelector('.hero [data-action="shuffle"]')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(80);
  }
  const notes = [...body.querySelectorAll('.note')].map((n) => n.textContent).join(' ');
  check('the note explains it has no genres rather than claiming 0%',
    body.querySelector('.hero h2')?.textContent === 'No Genres At All' && /no genres listed/i.test(notes),
    `${body.querySelector('.hero h2')?.textContent}: ${notes.slice(0, 90)}`);
}

console.log('\n--- a failed synopsis fetch is not cached ---');
{
  /* AniList rate-limits, and clicking through quickly fires a request per
   * card, so bursts produce failures. Caching those stored "no synopsis" for
   * the rest of the session — and since the card reserves five lines for it,
   * that showed as a hole rather than as nothing. */
  const NAMES = ['Action', 'Fantasy'];
  const mk = (r, i, t) => ({
    r, i, t, ty: 'TV', th: [], d: [], s: 8, g: [0, 1], e: 12, y: 2020,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });
  const cat = {
    built: '2026-08-19', count: 2, names: NAMES,
    anime: [mk(1, 600, 'Cache Source'), mk(2, 601, 'Cache Target')],
  };

  // Same object each call, so removing `errors` later turns failure into
  // success — the app's anilist() throws whenever errors are present.
  const payload = {
    errors: [{ message: 'Too Many Requests' }],
    data: { Media: { description: 'It arrived on the retry.', trailer: null } },
  };

  const dom = makeDom(cat, { anilist: payload, detail: payload });
  await sleep(200);
  let body = await pickAndRecommend(dom, 'Cache Source');
  dom.window.document.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(700);

  const failedText = body.querySelector('.synopsis')?.textContent || '';
  check('a failed fetch says so rather than leaving a blank block',
    /unavailable/i.test(failedText), failedText.slice(0, 60));

  delete payload.errors;                       // the rate limit passes

  body = await pickAndRecommend(dom, 'Cache Source');
  dom.window.document.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(700);

  check('the next visit retries instead of serving the cached failure',
    /arrived on the retry/i.test(body.querySelector('.synopsis')?.textContent || ''),
    body.querySelector('.synopsis')?.textContent?.slice(0, 60));
}

console.log('\n--- the card keeps its shape ---');
{
  /* Clicking "show me another" repeatedly is the main way this is used, and it
   * only feels right if the buttons stay put. Every block that used to appear
   * conditionally — banner, streaming row, trailer button — must be present
   * either way, so a sparse entry and a rich one produce the same skeleton.
   * jsdom has no layout, so this checks structure rather than pixels; it is
   * still enough to catch someone reinstating a conditional render. */
  const NAMES = ['Action', 'Fantasy'];
  const mk = (r, i, t, extra) => ({
    r, i, t, ty: 'TV', th: [], d: [], s: 8, g: [0, 1], e: 12, y: 2020,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
    ...extra,
  });

  const shapeOf = async (extra, label) => {
    const cat = {
      built: '2026-08-19', count: 2, names: NAMES,
      anime: [mk(1, 700, 'Shape Source', {}), mk(2, 701, 'Shape Target', extra)],
    };
    const dom = makeDom(cat);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Shape Source');
    dom.window.document.querySelector('[data-action="direction"][data-value="down"]')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    return {
      label,
      banner: !!body.querySelector('.hero-banner'),
      watch: !!body.querySelector('.watch'),
      trailer: !!body.querySelector('[data-action="trailer"]'),
      synopsis: !!body.querySelector('.synopsis'),
      // The recommend row arrives from the network like the synopsis does, and
      // has three possible states plus a failure. It belongs to this guard.
      recommend: !!body.querySelector('.recommend'),
    };
  };

  const rich = await shapeOf({ bn: 'a/b.jpg', tm: 1234, wp: { u: [0] } }, 'rich');
  const bare = await shapeOf({}, 'bare');

  for (const part of ['banner', 'watch', 'trailer', 'synopsis', 'recommend']) {
    check(`the ${part} block is present with artwork and data`, rich[part], JSON.stringify(rich));
    check(`the ${part} block is present without them`, bare[part], JSON.stringify(bare));
  }

  check('the blank banner is the one that fills in for a missing image',
    !!(await (async () => {
      const cat = {
        built: '2026-08-19', count: 2, names: NAMES,
        anime: [mk(1, 700, 'Shape Source', {}), mk(2, 701, 'Shape Target', {})],
      };
      const dom = makeDom(cat);
      await sleep(200);
      const body = await pickAndRecommend(dom, 'Shape Source');
      dom.window.document.querySelector('[data-action="direction"][data-value="down"]')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await sleep(300);
      return body.querySelector('.hero-banner-blank');
    })()));
}

console.log('\n--- the format filter ---');
{
  const NAMES = ['Action', 'Fantasy'];
  const mk = (r, i, t, ty) => ({
    r, i, t, ty, th: [], d: [], s: 8, g: [0, 1], e: 12, y: 2020,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const MIXED = {
    built: '2026-08-19', count: 7, names: NAMES,
    anime: [
      mk(1, 900, 'Source Show', 'TV'),
      mk(2, 901, 'A Web Release', 'ONA'),
      mk(3, 902, 'A Tape Release', 'OVA'),
      mk(4, 903, 'A Series', 'TV'),
      mk(5, 904, 'Another Web Release', 'ONA'),
      mk(6, 905, 'Another Tape Release', 'OVA'),
      mk(7, 906, 'Another Series', 'TV'),
    ],
  };

  const dom = makeDom(MIXED);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w = dom.window;

  const press = (value) => {
    body.querySelector(`[data-action="format"][data-value="${value}"]`)
      ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  };
  const shown = () => {
    const out = [];
    for (const el of body.querySelectorAll('.mini-card-title, .hero h2')) out.push(el.textContent);
    return out.join(' | ');
  };

  body.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);

  check('all three formats are offered by default', shown().includes('Web Release')
    && shown().includes('Tape Release'), shown());

  press('ONA');
  await sleep(200);
  check('switching ONA off drops web releases', !shown().includes('Web Release'), shown());
  check('switching ONA off keeps the others', shown().includes('Tape Release'), shown());

  press('OVA');
  await sleep(200);
  check('switching OVA off too leaves only TV',
    !shown().includes('Tape Release') && shown().includes('Series'), shown());

  // The last format on must stay on — otherwise there is nothing to recommend
  // and the card would empty itself with no way back except a page reload.
  press('TV');
  await sleep(200);
  check('the last remaining format cannot be switched off',
    shown().includes('Series'), shown());

  const saved = JSON.parse(w.localStorage.getItem('wanx:formats') || '[]');
  check('the choice is remembered', saved.length === 1 && saved[0] === 'TV', JSON.stringify(saved));

  press('ONA');
  await sleep(200);
  check('switching a format back on restores it', shown().includes('Web Release'), shown());
}

console.log('\n--- the year filter ---');
{
  const NAMES = ['Action', 'Fantasy'];
  const mk = (r, i, t, y) => ({
    r, i, t, y, ty: 'TV', th: [], d: [], s: 8, g: [0, 1], e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  /* One entry has no year at all. 13 real ones are in that state, and they
     have to survive the filter: that is a gap in MyAnimeList's data, not an
     era anybody chose to leave out — the same rule as an entry with no type
     surviving the format filter. */
  const ERAS = {
    built: '2026-08-19', count: 6, names: NAMES,
    anime: [
      mk(1, 900, 'Source Show', 2020),
      mk(2, 901, 'An Old Classic', 1998),
      mk(3, 902, 'A Modern Series', 2015),
      mk(4, 903, 'Another Old One', 2004),
      mk(5, 904, 'Another Modern One', 2021),
      { ...mk(6, 905, 'An Undated Show', 2020), y: undefined },
    ],
  };

  const dom = makeDom(ERAS);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w = dom.window;

  const chip = () => body.querySelector('[data-action="modern"]');
  const press = () => chip()?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const shown = () => {
    const out = [];
    for (const el of body.querySelectorAll('.mini-card-title, .hero h2')) out.push(el.textContent);
    return out.join(' | ');
  };

  body.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(200);

  check('the year chip is offered', Boolean(chip()), body.querySelector('.controls')?.textContent);
  check('and is off by default, so nothing is hidden until it is asked for',
    chip().getAttribute('aria-pressed') === 'false', chip().outerHTML);
  check('older shows are recommended with it off', shown().includes('Old'), shown());

  /* The whole reason this is one chip rather than a fourth toggle row: three
     rows already pushed the card most of a screen down at 360px. The chip
     fits on the first row only because it sits directly after the direction
     group -- appended at the end of .controls it wraps to a row of its own,
     measured in a real browser at 320, 360, 375 and 414px. jsdom has no
     layout, so this guards the DOM position that produces that result. */
  const groups = [...body.querySelectorAll('.controls > .direction')];
  check('the chip rides in the existing toggle row rather than adding one',
    groups.length > 1 && groups[1].contains(chip()),
    groups.map((g) => g.getAttribute('aria-label')).join(' | '));

  press();
  await sleep(200);
  check('switching it on drops everything older', !shown().includes('Old'), shown());
  check('and keeps everything from 2010 on', shown().includes('Modern'), shown());
  /* A missing year is a data gap, not a choice. */
  check('an entry with no year on record is kept rather than assumed old',
    shown().includes('Undated'), shown());

  check('the choice is remembered', w.localStorage.getItem('wanx:modern') === '1',
    String(w.localStorage.getItem('wanx:modern')));

  press();
  await sleep(200);
  check('switching it back off restores the older shows', shown().includes('Old'), shown());
  check('and that is remembered too', w.localStorage.getItem('wanx:modern') === '0',
    String(w.localStorage.getItem('wanx:modern')));

  /* Same rule as the format and watched filters: it filters candidates, never
     the anchor. "I watched this in 1998, what next" is exactly what the site
     is for, so refusing the old show someone just typed would be baffling. */
  press();
  await sleep(200);
  const oldAnchor = await pickAndRecommend(dom, 'An Old Classic');
  await sleep(200);
  check('an old show is still usable as an anchor with the filter on',
    !oldAnchor.querySelector('.state'),
    oldAnchor.querySelector('.state')?.textContent ?? 'got a card');
}

console.log('\n--- filters count what they actually removed ---');
{
  /* Both counters feed a sentence that says "shows that matched", so they
     have to count matches. They used to be applied before the genre test, and
     collectTiers walks the entire catalogue in each direction -- so the number
     reported was really the size of the filter itself. A watched list of
     nothing-in-common shows made the card claim every one of them matched,
     and the year chip said 1,426, the whole pre-2010 catalogue. */
  const NAMES = ['Action', 'Sports'];
  const mk = (r, i, t, g, y) => ({
    r, i, t, g, y, ty: 'TV', th: [], d: [], s: 8, e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const SPLIT = {
    built: '2026-08-19', count: 5, names: NAMES,
    anime: [
      mk(1, 900, 'Source Show', [0], 2020),      // Action
      mk(2, 901, 'A Shared Match', [0], 2021),   // Action  — matches
      mk(3, 902, 'A Sports Thing', [1], 2021),   // Sports  — shares nothing
      mk(4, 903, 'Another Sports Thing', [1], 2021),
      mk(5, 904, 'A Third Sports Thing', [1], 2021),
    ],
  };

  // Every non-matching entry is on the watched list; the one real match is not.
  // Seeded through makeDom so it is in place before app.js reads it.
  const dom = makeDom(SPLIT, { seedWatched: [902, 903, 904] });
  const w = dom.window;
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  body.querySelector('[data-action="direction"][data-value="down"]')
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(250);

  const notes = [...body.querySelectorAll('.note')].map((n) => n.textContent).join(' ');
  check('a watched show that shares no genre is not counted as a skipped match',
    !/watched list/.test(notes), notes || '(no notes)');
}

console.log('\n--- the tip jar ---');
{
  /* Launched in build 49, after the r/anime post had gone up -- that sub bans
     advertising crowdfunding and the announcement is a one-shot, so the order
     mattered. The checks now assert the launched state, and that emptying the
     constant still turns it off completely, which is the whole of the switch. */
  const dom = makeDom(SYNTHETIC);
  await sleep(200);
  const credit = dom.window.document.querySelector('.credit');
  const link = credit.querySelector('.tip-jar');

  check('the tip jar renders on the credit line', Boolean(link), credit.textContent);
  check('and points at the Ko-fi page',
    link?.getAttribute('href') === 'https://ko-fi.com/whatanimeshouldiwatchnext',
    link?.getAttribute('href'));
  check('and opens away from the page safely',
    link?.getAttribute('target') === '_blank' && /noopener/.test(link?.getAttribute('rel') || ''),
    link?.outerHTML);

  /* The build marker is the first thing to check when a result looks wrong, so
     it stays where it is looked for: last. */
  check('the build marker is still the last thing on the credit line',
    credit.lastElementChild?.classList.contains('build'), credit.innerHTML.slice(-90));

  /* The card must not move to accommodate it. The credit line is on the
     landing view only, so this is structural rather than a matter of styling
     -- but it is asserted, because "outside .hero" is the rule every addition
     to this page has had to meet. */
  check('it is nowhere near the card',
    !dom.window.document.querySelector('.hero .tip-jar')
      && !dom.window.document.querySelector('#result-view .tip-jar'),
    'tip jar found inside the result view');

  /* Turning it off is emptying the string, and nothing else. Booting a patched
     copy proves that rather than trusting it. */
  function bootWith(url) {
    const d = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
    d.window.scrollTo = () => {};
    d.window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SYNTHETIC) });
    d.window.eval(appSource.replace(
      /const TIP_JAR_URL = '[^']*';/, `const TIP_JAR_URL = ${JSON.stringify(url)};`));
    return d;
  }

  const off = bootWith('');
  await sleep(200);
  const offCredit = off.window.document.querySelector('.credit');
  check('emptying the constant removes it entirely',
    !offCredit.querySelector('.tip-jar'), offCredit.textContent);
  check('and the credit line still ends with the build marker when it is off',
    offCredit.lastElementChild?.classList.contains('build'), offCredit.innerHTML.slice(-90));
}


console.log('\n--- housekeeping row and stat honesty ---');
{
  /* "Remove my ratings" reaches the server and undoes something you gave, so
     it is the more alarming of the two housekeeping buttons -- and it was the
     one that never hid itself. Clear had the rule; this did not. */
  const dom = makeDom(SYNTHETIC);
  await sleep(200);
  const doc = dom.window.document;
  const forget = doc.getElementById('forget-ratings-btn');
  const clear = doc.getElementById('clear-watched-btn');

  check('Remove my ratings is hidden when you have given none',
    forget?.hidden === true, `hidden=${forget?.hidden}`);
  check('and Clear is hidden when nothing is watched, as before',
    clear?.hidden === true, `hidden=${clear?.hidden}`);

  // With a rating stored before boot, it has something to remove and appears.
  const d2 = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
  d2.window.scrollTo = () => {};
  d2.window.localStorage.setItem('wanx:myvotes:v1', JSON.stringify({ '100': true }));
  d2.window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SYNTHETIC) });
  d2.window.eval(appSource);
  await sleep(200);
  check('and it appears once there is a rating to remove',
    d2.window.document.getElementById('forget-ratings-btn')?.hidden === false,
    `hidden=${d2.window.document.getElementById('forget-ratings-btn')?.hidden}`);
}

{
  /* A missing episode count means "still airing", which the cell beside it
     already says. A question mark there reads as broken data instead. */
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', su: [0],
    stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 }, ...extra,
  });
  const CAT = {
    built: '2026-08-24', count: 2, names: NAMES,
    studios: ['TMS Entertainment'],
    anime: [
      mk(1, 980, 'Endless Ongoing Thing', { e: null, st: 'air', y: 1996 }),
      mk(2, 981, 'Source Show'),
    ],
  };

  const dom = makeDom(CAT);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  await sleep(200);

  const stats = body.querySelector('.stats')?.textContent || '';
  check('an unknown episode count renders as a dash, not a question mark',
    /—episodes/.test(stats) && !/\?episodes/.test(stats), stats.replace(/\s+/g, ' '));

  /* The studio is clipped to 15ch in CSS, so the tooltip is the only place the
     full name survives -- and it used to say "Animation studio", which the
     label under it already says. */
  const studio = body.querySelector('.stat-studio');
  check('the clipped studio name is recoverable from its tooltip',
    /TMS Entertainment/.test(studio?.getAttribute('title') || ''),
    studio?.getAttribute('title'));
}

console.log('\n--- the wordmark palette ---');
{
  /* The wordmark is a deliberate nod to a certain search page, and that is the
     point. But two of its six colours were that company's registered brand
     hexes verbatim, in their exact order, over a centred search box. Colours
     are not copyrightable so that was never the risk; shipping someone else's
     actual brand values is a trademark question, and avoiding it costs
     nothing. This guards the two that moved. */
  const css = readFileSync(`${ROOT}/styles.css`, 'utf8');
  /* Comments stripped first: the stylesheet names both old hexes in the note
     explaining why they moved, and a hex in a comment is not a shipped
     colour. */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const brandHexes = ['#4285f4', '#34a853'];
  const lower = code.toLowerCase();
  const found = brandHexes.filter((h) => lower.includes(h));
  check('no other company\u2019s brand hex is used as a wordmark colour',
    found.length === 0, found.join(', '));

  /* All six letters still get a colour: the guard above must not be satisfied
     by the palette quietly disappearing. */
  const parts = ['w-what', 'w-anime', 'w-should', 'w-i', 'w-watch', 'w-next'];
  /* Plain string work rather than a built regex: a heredoc halved the
     backslashes in the first version of this file, which left the brand-hex
     check matching nothing and passing for that reason alone. */
  const coloured = parts.filter((p) => {
    const at = code.indexOf(`.${p} `);
    return at !== -1 && code.slice(at, at + 60).includes('color:');
  });
  check('and all six parts of the wordmark are still coloured',
    coloured.length === 6, coloured.join(', '));

  /* The wordmark is large display text, so the bar is 3:1. Yellow is the one
     colour that cannot be the same in both themes: vivid enough to look right
     on the dark background, it scores 1.85:1 on white and fails even that
     bar. Computed here rather than eyeballed, so a future palette tweak
     cannot quietly drop below it again. */
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  };
  const contrast = (a, b) => {
    const x = luminance(a); const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const valueOf = (name, from) => {
    const at = from.indexOf(name);
    return at === -1 ? null : from.slice(at + name.length).match(/#[0-9a-f]{6}/i)?.[0];
  };
  const darkBlock = code.slice(code.indexOf('prefers-color-scheme: dark'));
  const yellowLight = valueOf('--wordmark-yellow:', code);
  const yellowDark = valueOf('--wordmark-yellow:', darkBlock);

  check('the wordmark yellow clears 3:1 on the light theme',
    yellowLight && contrast(yellowLight, '#ffffff') >= 3,
    `${yellowLight} -> ${yellowLight ? contrast(yellowLight, '#ffffff').toFixed(2) : '?'}:1`);
  check('and still clears it on the dark theme',
    yellowDark && contrast(yellowDark, '#17181a') >= 3,
    `${yellowDark} -> ${yellowDark ? contrast(yellowDark, '#17181a').toFixed(2) : '?'}:1`);
  check('every other wordmark colour clears 3:1 on white too',
    ['#2f7fd6', '#1f9d55', '#e5484d'].every((c) => contrast(c, '#ffffff') >= 3),
    ['#2f7fd6', '#1f9d55', '#e5484d'].map((c) => `${c} ${contrast(c, '#ffffff').toFixed(2)}`).join(', '));

  /* The housekeeping links sit directly under the two buttons the page exists
     for. Underlining them made them the third-loudest thing on screen. */
  const linkish = code.slice(code.indexOf('.linkish {'), code.indexOf('.linkish {') + 200);
  check('the housekeeping links are not underlined at rest',
    /text-decoration:\s*none/.test(linkish), linkish.replace(/\s+/g, ' '));
  const hover = code.slice(code.indexOf('.linkish:hover'), code.indexOf('.linkish:hover') + 200);
  check('but still underline on hover, so they read as links',
    /text-decoration:\s*underline/.test(hover), hover.replace(/\s+/g, ' '));
}

console.log('\n--- prerendered pages ---');
{
  /* Results are prerendered one document per entry, which means the page is no
     longer always served from the site root. Every path it fetches has to be
     absolute or it resolves against /anime/<id>/<slug>/ and 404s — which is
     exactly what happened the first time this was tried: the stylesheet, the
     script, the catalogue and both API routes all broke at once, and the page
     rendered as unstyled HTML with no app on it. */
  const index = readFileSync(`${ROOT}/index.html`, 'utf8');
  const app = readFileSync(`${ROOT}/app.js`, 'utf8');

  check('the stylesheet is an absolute path', index.includes('href="/styles.css'),
    /href="[^"]*styles\.css[^"]*"/.exec(index)?.[0]);
  check('the script is an absolute path', index.includes('src="/app.js'),
    /src="[^"]*app\.js[^"]*"/.exec(index)?.[0]);
  check('the catalogue is fetched from an absolute path',
    /CATALOGUE_URL = '\/anime\.json'/.test(app),
    /CATALOGUE_URL = '[^']*'/.exec(app)?.[0]);
  check('the vote endpoints are absolute',
    !app.includes("fetch('api/vote'") && !app.includes('fetch(`api/ratings'),
    'a relative api/ path survives');

  /* Going home from /anime/<id>/<slug>/ must not resolve relative to it.
     './' meant /anime/<id>/ and was harmless only while every URL sat at the
     root. */
  check('going home writes an absolute path',
    !/history\.pushState\(\{\}, '', '\.\/'\)/.test(app), "goHome still pushes './'");

  /* The generator must exist and must drive the real app rather than carry a
     second copy of the matcher, which would drift where nobody looks. */
  const gen = readFileSync(`${ROOT}/build-seo-pages.mjs`, 'utf8');
  check('the page generator calls the real walkRankings',
    gen.includes('walkRankings(') && gen.includes("readFileSync(join(ROOT, 'app.js')"),
    'generator may be reimplementing the walk');
}

{
  /* A prerendered page has to hydrate: the crawler block is replaced by the
     real card, and a visitor never sees both. */
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });
  const CAT = {
    built: '2026-08-24', count: 2, names: NAMES,
    anime: [mk(1, 700, 'Higher Show'), mk(2, 701, 'Source Show')],
  };

  const withBlock = html.replace('<main id="app">',
    '<main id="app"><div id="seo-content"><h1>What to watch after Source Show</h1></div>');
  const dom = new JSDOM(withBlock, {
    runScripts: 'dangerously', url: 'https://example.com/anime/701/source-show/', pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  dom.window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CAT) });
  dom.window.eval(appSource);
  await sleep(400);

  const doc = dom.window.document;
  check('a path URL routes to the right anime without a query string',
    /Because you watched Source Show/.test(doc.getElementById('result-body')?.textContent || ''),
    doc.getElementById('result-body')?.textContent?.slice(0, 80));
  check('and the crawler block is removed once the card is up',
    !doc.getElementById('seo-content'), 'seo-content survived hydration');
}

console.log('\n--- prerendered pages stay in step with the catalogue ---');
{
  /* A stale page is worse than no page: it points a crawler at a title that
     may no longer be in the catalogue, and it advertises recommendations the
     site would not give. Nothing here catches a *subtly* stale page, but these
     catch the two ways it goes obviously wrong — pages missing entirely, and
     a sitemap that disagrees with what was written. */
  const shipped = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const withGenres = shipped.anime.filter((a) => (a.g || []).length);
  const sitemap = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const animeLocs = locs.filter((u) => u.includes('/anime/'));

  check('every entry with genres has a prerendered page',
    animeLocs.length === withGenres.length,
    `${animeLocs.length} pages vs ${withGenres.length} entries with genres`);

  check('the sitemap also lists the home page and the privacy page',
    locs.some((u) => u.endsWith('.com/')) && locs.some((u) => u.endsWith('/privacy')),
    locs.slice(0, 2).join(' '));

  /* Sampled rather than exhaustive: reading 3,462 files would dominate the
     suite's runtime for a check whose failure mode is all-or-nothing. */
  const sample = [0, 1, 7, 40, 200, 900, 2000, 3000].map((i) => withGenres[i]).filter(Boolean);
  const missing = [];
  for (const row of sample) {
    const hit = animeLocs.find((u) => u.includes(`/anime/${row.i}/`) || u.endsWith(`/anime/${row.i}`));
    if (!hit) { missing.push(row.t); continue; }
    const rel = hit.replace('https://whatanimeshouldiwatchnext.com', '');
    let page;
    try { page = readFileSync(`${ROOT}${rel}/index.html`, 'utf8'); } catch { missing.push(row.t); continue; }
    if (!page.includes(`What to watch after ${row.t}`)) missing.push(row.t);
  }
  check('a sampled page exists on disk and names its own anime',
    missing.length === 0, missing.join(', '));

  /* The pages carry the walk's own output, so they must not contradict the
     card. This asserts the shape rather than the content: every page links to
     other entries, which is also what makes the catalogue crawlable at all. */
  const first = animeLocs[0].replace('https://whatanimeshouldiwatchnext.com', '');
  const page = readFileSync(`${ROOT}${first}/index.html`, 'utf8');
  check('a page links onward to other anime, so a crawler can walk the catalogue',
    (page.match(/href="\/anime\//g) || []).length >= 5,
    String((page.match(/href="\/anime\//g) || []).length));
  check('and carries its own canonical rather than the site root',
    page.includes(`<link rel="canonical" href="https://whatanimeshouldiwatchnext.com${first}">`),
    /<link rel="canonical"[^>]*>/.exec(page)?.[0]);

  /* Every one of these must be the URL Pages actually serves. A page written
     to anime/<id>/<slug>/index.html answers 200 at the trailing-slash form and
     308s the bare path to it — so without the slash the sitemap would point a
     crawler at 3,462 redirects, which spends crawl budget and dilutes the
     signal on arrival. Shipped that way once and caught by calling the live
     site, not by reading the file. */
  check('every prerendered URL is the form the server answers 200 for',
    animeLocs.every((u) => u.endsWith('/')),
    animeLocs.filter((u) => !u.endsWith('/')).slice(0, 3).join(', '));
  check('and app.js writes that same form into the address bar',
    /`\/anime\/\$\{anime\.id\}\/\$\{slug\}\/`/.test(readFileSync(`${ROOT}/app.js`, 'utf8')),
    'urlFor may be dropping the trailing slash');
}

console.log('\n--- a single genre still demotes ---');
{
  /* Both demotions drop a candidate one tier, and the floor is 1 — so when a
     candidate already shares exactly one genre the move lands it back where it
     started and the rule silently does nothing. A source with one genre has no
     tier above 1 at all, which is 854 entries, a quarter of the catalogue.
     The demotion now applies inside the tier instead. */
  const NAMES = ['Slice of Life', 'Kids'];
  const mk = (r, i, t, e, extra = {}) => ({
    r, i, t, e, s: 8, g: [0], th: [], d: [], ty: 'TV', y: 2015,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 }, ...extra,
  });

  /* One genre between them, so every match is a 1-of-1 and there is nowhere
     above tier 1 to demote into. The long one is nearest, so without the fix
     proximity puts it first. */
  const CAT = {
    built: '2026-08-24', count: 4, names: NAMES,
    anime: [
      mk(1, 810, 'Distant Short Show', 12),
      mk(2, 811, 'Nearer Short Show', 10),
      mk(3, 812, 'Nearest Long Show', 200),
      mk(4, 813, 'Source Show', 12),
    ],
  };

  const dom = makeDom(CAT);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  await sleep(200);

  const order = [...body.querySelectorAll('.hero h2, .mini-card-title')].map((e) => e.textContent);
  const longAt = order.findIndex((t) => /Nearest Long Show/.test(t));
  const shortAt = order.findIndex((t) => /Nearer Short Show/.test(t));

  check('a 6x-longer show does not lead a single-genre walk just for being nearest',
    !/Nearest Long Show/.test(body.querySelector('.hero h2')?.textContent || ''),
    body.querySelector('.hero h2')?.textContent);
  check('it sorts behind the closer-sized matches in its own tier',
    longAt === -1 || (shortAt !== -1 && shortAt < longAt), order.join(' | '));
  /* Demoted, not deleted — the whole point is that it surfaces once
     closer-sized matches run out. */
  check('but is still reachable rather than dropped',
    order.some((t) => /Nearest Long Show/.test(t)), order.join(' | '));

  /* The floor exists so a real genre match never sinks below tier 0, which
     holds entries with no genres at all matched on a theme alone. */
  const app = readFileSync(`${ROOT}/app.js`, 'utf8');
  check('and nothing was demoted into the genre-less tier to achieve it',
    app.includes('Math.max(1, shared - 1)'), 'the tier floor of 1 was removed');
}

/* ---------- link previews and crawler files ---------- */
/* A wrong og:image fails silently — the scraper simply shows no picture, and
   you find out from someone else's timeline. These assert the two things that
   go wrong in a way nobody would notice locally: a relative image URL, and a
   declared size that no longer matches the file on disk. */

console.log('\n--- link previews ---');
{
  const head = new JSDOM(html).window.document;
  const meta = (sel) => head.querySelector(sel)?.getAttribute('content') ?? '';
  const SITE = 'https://whatanimeshouldiwatchnext.com';

  check('the card type is the large one', meta('meta[name="twitter:card"]') === 'summary_large_image');
  check('og:image is absolute', meta('meta[property="og:image"]').startsWith('https://'),
    meta('meta[property="og:image"]'));
  check('twitter:image is absolute', meta('meta[name="twitter:image"]').startsWith('https://'),
    meta('meta[name="twitter:image"]'));
  check('og:url is the bare hostname', meta('meta[property="og:url"]') === `${SITE}/`,
    meta('meta[property="og:url"]'));
  check('the canonical link matches og:url',
    head.querySelector('link[rel="canonical"]')?.getAttribute('href') === `${SITE}/`);
  check('both preview images carry alt text',
    !!meta('meta[property="og:image:alt"]') && !!meta('meta[name="twitter:image:alt"]'));
  check('title and description reach both scrapers',
    !!meta('meta[property="og:title"]') && !!meta('meta[name="twitter:title"]')
    && !!meta('meta[property="og:description"]') && !!meta('meta[name="twitter:description"]'));

  /* Read the real dimensions out of the PNG rather than trusting the tags:
     IHDR carries width at byte 16 and height at byte 20. */
  const png = readFileSync(`${ROOT}/og.png`);
  check('og.png is a real PNG', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    png.subarray(0, 8).toString('hex'));
  const pw = png.readUInt32BE(16), ph = png.readUInt32BE(20);
  check('the declared width matches the file', String(pw) === meta('meta[property="og:image:width"]'),
    `${pw} vs ${meta('meta[property="og:image:width"]')}`);
  check('the declared height matches the file', String(ph) === meta('meta[property="og:image:height"]'),
    `${ph} vs ${meta('meta[property="og:image:height"]')}`);
  check('the preview is the 1.91:1 both scrapers want', pw === 1200 && ph === 630, `${pw}x${ph}`);

  const robots = readFileSync(`${ROOT}/robots.txt`, 'utf8');
  const sitemap = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
  check('robots.txt points at the sitemap', robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
  /* Blocking these would leave a crawler rendering an empty shell and judging
     the site on it, which is worse than not being crawled at all. */
  check('robots.txt leaves the rendering assets crawlable',
    !/Disallow: \/(app\.js|styles\.css|anime\.json)/.test(robots));
  check('robots.txt keeps the build scripts out', robots.includes('Disallow: /build-catalogue.mjs'));
  check('the sitemap lists the canonical root', sitemap.includes(`<loc>${SITE}/</loc>`));
}

/* ---------- when anime.json does not load ---------- */
/* Every one of these was a real silent failure before build 31: the landing
   page rendered perfectly and then ignored the search box, and the dice sat on
   a spinner that never resolved. Worse, the memo cached the rejection, so one
   dropped request kept the session broken until a reload. */

console.log('\n--- when the catalogue does not load ---');
{
  const TINY = {
    built: 'x', count: 2, names: ['Action'],
    anime: [
      { r: 1, i: 1, t: 'Real Show', s: 9, g: [0], th: [], ty: 'TV', e: 12, y: 2013, m: 100, im: 'a.jpg' },
      { r: 2, i: 2, t: 'Other Show', s: 8, g: [0], th: [], ty: 'TV', e: 12, y: 2012, m: 100, im: 'b.jpg' },
    ],
  };

  /* `failure` is a live switch so a test can let the network come back and
     press Try again — which is the only way to prove the rejection is not
     cached. */
  function makeFailingDom(failure) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
    dom.window.scrollTo = () => {};
    const state = { mode: failure };
    dom.window.fetch = (target) => {
      if (String(target).includes('anilist')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { Page: { media: [] } } }) });
      }
      if (state.mode === null) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TINY) });
      if (state.mode === 'status') return Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('x')) });
      if (state.mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')) });
    };
    dom.window.eval(appSource);
    return { dom, state };
  }

  const notice = (d) => {
    /* Null-tolerant so that running these against a build without the element
       reports a failed check rather than crashing the suite. */
    const el = d.getElementById('catalogue-notice');
    return !el || el.hidden ? '' : el.textContent;
  };
  const resultText = (d) => d.getElementById('result-body').textContent.replace(/\s+/g, ' ').trim();

  /* An unhandled rejection is not cosmetic here: it is exactly the shape the
     old bug took, so the suite watches for one rather than trusting the DOM. */
  const stray = [];
  const watch = (r) => stray.push(String(r));
  process.on('unhandledRejection', watch);

  {
    const { dom } = makeFailingDom('offline');
    await sleep(300);
    const d = dom.window.document;
    check('a failed boot says so instead of looking fine', notice(d).length > 0, '(notice hidden)');

    const input = d.getElementById('search-input');
    input.value = 'Real';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(400);
    const dropdown = d.getElementById('suggestions').textContent.replace(/\s+/g, ' ').trim();
    check('typing reports the failure rather than doing nothing', dropdown.length > 0, '(empty dropdown)');
    /* Reported in the dropdown, not by replacing the view under the cursor. */
    check('typing does not throw the landing page away', d.getElementById('search-view').hidden === false);

    d.getElementById('random-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    check('the dice stops on an error, not on the spinner',
      !resultText(d).includes('Rolling the dice'), resultText(d));
    check('the error offers a way to try again', !!d.querySelector('[data-action="retry"]'));
  }

  {
    /* The one that matters: a transient failure must not poison the session. */
    const { dom, state } = makeFailingDom('offline');
    await sleep(300);
    const d = dom.window.document;
    d.getElementById('random-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(300);

    state.mode = null;
    d.querySelector('[data-action="retry"]')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(500);
    check('a failed load is not cached, so a retry can succeed',
      resultText(d).includes('Because you watched'), resultText(d).slice(0, 90));
    check('the notice clears once the catalogue arrives', notice(d) === '', notice(d));
  }

  {
    const { dom } = makeFailingDom('status');
    await sleep(300);
    check('an HTTP failure names the status', notice(dom.window.document).includes('503'),
      notice(dom.window.document));
  }

  {
    /* A deploy in flight serves index.html for anime.json, so this arrives as a
       parse error rather than a bad status, and is worth saying differently. */
    const { dom } = makeFailingDom('damaged');
    await sleep(300);
    const said = notice(dom.window.document);
    check('a damaged catalogue is described as damaged, not as offline',
      said.includes('damaged') && !said.includes('connection'), said);
  }

  {
    const { dom } = makeFailingDom(null);
    await sleep(400);
    check('a healthy boot leaves the notice hidden', notice(dom.window.document) === '',
      notice(dom.window.document));
  }

  check('none of it leaks an unhandled rejection', stray.length === 0, stray.join(' | '));
  process.off('unhandledRejection', watch);
}

console.log('\n--- analytics ---');
{
  const head = new JSDOM(html).window.document;
  const beacon = head.querySelector('script[data-cf-beacon]');
  check('the analytics beacon is present', !!beacon);
  check('the beacon carries a token',
    !!(beacon && JSON.parse(beacon.getAttribute('data-cf-beacon')).token), beacon?.getAttribute('data-cf-beacon'));
  /* A module script defers itself. A blocking one would sit in front of the
     catalogue fetch, which is the only thing on this page worth waiting for. */
  check('the beacon cannot block the catalogue fetch',
    beacon?.getAttribute('type') === 'module' || beacon?.hasAttribute('defer') || beacon?.hasAttribute('async'),
    beacon?.outerHTML.slice(0, 80));
  /* jsdom only fetches external scripts when built with `resources: usable`.
     Nothing here does, which is what keeps a real network call to Cloudflare
     out of every test run. Asserted against this file's own source, because the
     day someone turns that on is the day the suite silently stops being
     hermetic. */
  check('the suite never enables external resource loading',
    !/resources\s*:\s*['"]usable/.test(readFileSync(`${ROOT}/test/suite.mjs`, 'utf8')));
}

/* ---------- the watched list ---------- */
/* Stage 1 of the voting work: remember what you have already seen, and stop
   recommending it. Entirely local — no account, no server, nothing uploaded. */

console.log('\n--- the watched list ---');
{
  const G2 = ['Action', 'Fantasy'];
  const mk = (r, i, t) => ({ r, i, t, s: 9 - r / 10, g: [0, 1], th: [], ty: 'TV', e: 12, y: 2013, m: 1000, im: 'x.jpg' });
  const CAT = {
    built: 'x', count: 3, names: G2,
    anime: [mk(1, 501, 'Alpha Show'), mk(2, 502, 'Gamma Show'), mk(3, 503, 'Source Show')],
  };

  /* Its own factory rather than makeDom, so the module-scope helpers can be
     reached from the test, and so the watched list can be seeded before the
     script boots and reads it. */
  function boot(seed, wire) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
    dom.window.scrollTo = () => {};
    if (seed) dom.window.localStorage.setItem('wanx:watched:v1', JSON.stringify(seed));
    dom.window.fetch = (t, o) => {
      const href = String(t);
      if (href.includes('api/ratings')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ratings: {}, floor: 30 }) });
      }
      if (href.includes('api/vote')) {
        const body = JSON.parse(o?.body || '{}');
        if (o?.method === 'DELETE') {
          const answer = wire?.onForget ? wire.onForget(body) : { removed: 0, remaining: 0 };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
        }
        wire?.onShare?.(body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ recorded: body.votes?.length || 1 }) });
      }
      return String(t).includes('anilist')
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { Page: { media: [] } } }) })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CAT) });
    };
    dom.window.eval(`${appSource}
      window.__parseExport = parseExport;
      window.__markWatched = markWatched;
      window.__watched = () => [...watched];`);
    return dom;
  }

  const XML = `<?xml version="1.0" encoding="UTF-8"?>
    <myanimelist>
      <anime><series_animedb_id>501</series_animedb_id><my_status>Completed</my_status></anime>
      <anime><series_animedb_id>502</series_animedb_id><my_status>Watching</my_status></anime>
      <anime><series_animedb_id>777</series_animedb_id><my_status>Dropped</my_status></anime>
      <anime><series_animedb_id>888</series_animedb_id><my_status>On-Hold</my_status></anime>
      <anime><series_animedb_id>999</series_animedb_id><my_status>Plan to Watch</my_status></anime>
    </myanimelist>`;

  {
    const dom = boot();
    await sleep(200);
    const w = dom.window;
    const { ids, planned } = w.__parseExport(XML);
    check('the import reads a MyAnimeList export', ids.length === 4, JSON.stringify(ids));
    /* Plan-to-watch is usually the biggest section of a list, and you have not
       seen any of it — treating it as watched would hide the very things
       someone is most likely to want recommended. */
    check('plan-to-watch is left out', !ids.includes(999) && planned === 1, `${ids} planned=${planned}`);
    check('dropped and on-hold count as seen', ids.includes(777) && ids.includes(888), JSON.stringify(ids));

    check('importing twice adds nothing the second time',
      w.__markWatched(ids) === 4 && w.__markWatched(ids) === 0);
    const saved = JSON.parse(w.localStorage.getItem('wanx:watched:v1') || '[]');
    check('the list survives in local storage', saved.length === 4, JSON.stringify(saved));

    let threw = '';
    try { w.__parseExport('<html><body>not a list</body></html>'); } catch (e) { threw = e.message; }
    check('a file that is not an export is rejected', threw.length > 0, threw);
  }

  {
    /* Alpha is the best match above Source. Marked watched, the walk should
       reach past it to Gamma rather than offering it again. */
    const dom = boot([501]);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    const hero = body?.querySelector('.hero h2')?.textContent;
    check('a watched show is not recommended', hero !== 'Alpha Show', hero);
    check('the next-best one is offered instead', hero === 'Gamma Show', hero);
  }

  {
    /* The same rule as the format filter: it filters candidates, never the
       anchor. Refusing to accept a show because you have seen it would break
       the one thing this site is for. */
    const dom = boot([501]);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Alpha Show');
    check('a watched show still works as an anchor',
      /Because you watched Alpha Show/.test(body?.textContent.replace(/\s+/g, ' ') || ''),
      body?.textContent.replace(/\s+/g, ' ').slice(0, 90));
  }

  {
    /* The other half of the same idea, and the common case. When the list
       removes only *some* candidates a result still comes back, and until
       build 36 the page said nothing at all about why it had changed. Logged
       in, GATE: Jieitai returns Slayers because Moonlit Fantasy, Drifters,
       Berserk: Ougon Jidai-hen and Juuni Kokuki are all already watched --
       correct, and it reads as the matcher being broken. */
    const dom = boot([501]);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    const txt = body?.textContent.replace(/\s+/g, ' ') || '';
    check('a walk that lost some candidates says the list did it',
      /already on your watched list, so/.test(txt), txt.slice(0, 200));
    check('and counts them', /\b1 show that matched is\b/.test(txt), txt.slice(0, 200));

    /* It is an explanation of the card, so it sits below the card with the
       other notes. A note that appears above moves the card and every button
       in it, and this one appears exactly when the result changed. */
    const hero = body?.querySelector('.hero');
    const note = [...(body?.querySelectorAll('.note') || [])]
      .find((n) => /already on your watched list/.test(n.textContent));
    check('and it renders below the card, not above it',
      Boolean(hero && note) &&
        (hero.compareDocumentPosition(note) & 4) === 4,   // note FOLLOWS hero
      note ? 'note found, wrong side' : 'no note');
  }

  {
    /* Nothing removed, nothing to explain -- the note must not appear at all,
       or it becomes noise on every card. */
    const dom = boot([]);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    const txt = body?.textContent.replace(/\s+/g, ' ') || '';
    check('and stays quiet when the list removed nothing',
      !/already on your watched list/.test(txt), txt.slice(0, 160));
  }

  {
    /* If the watched list is what emptied the walk, say so. "Nothing shares
       these genres" would be false, and would read as the matcher breaking. */
    const dom = boot([501, 502]);
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    const txt = body?.textContent.replace(/\s+/g, ' ') || '';
    check('an empty walk blames the watched list, not the genres',
      txt.includes('already on your watched list'), txt.slice(0, 140));
  }

  {
    const dom = boot([501]);
    await sleep(200);
    const w = dom.window;
    const label = w.document.getElementById('watched-count');
    check('the landing page reports the count', /1 title/.test(label.textContent), label.textContent);
    w.document.getElementById('clear-watched-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    check('clearing empties it', w.__watched().length === 0, JSON.stringify(w.__watched()));
    check('and the label says so', /Nothing marked/.test(label.textContent), label.textContent);
  }
}

/* ---------- signature themes ---------- */

console.log('\n--- REAL catalogue: signature themes ---');
{
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const dom = makeDom(real);
  await sleep(500);
  const w = dom.window;
  const signature = new Set(w.__signatureThemes());

  /* Rarity is the whole point. A theme carried by a fifth of the catalogue
     describes a show; one carried by a twentieth identifies it. */
  check('Isekai counts as a signature theme', signature.has('Isekai'));
  check('Time Travel counts as a signature theme', signature.has('Time Travel'));
  check('School is too common to count', !signature.has('School'));
  check('Historical is too common to count', !signature.has('Historical'));
  check('every signature theme is rarer than one entry in twenty',
    [...signature].every((t) => real.anime.filter((a) => (a.th || [])
      .map((i) => real.names[i]).includes(t)).length <= real.anime.length * 0.05),
    `${signature.size} themes`);

  /* The documented failure this was built for: Konosuba's genres are
     Adventure, Comedy and Fantasy, and exactly one thing above it shares all
     three — 163 places away. Serving that lone distant match dragged the
     high-water mark to the top of the rankings, and monotonicity then deferred
     every nearer isekai, including one 24 places away. Seven results, not one
     of them an isekai. */
  const body = await pickAndRecommend(dom, 'Kono Subarashii Sekai ni Shukufuku wo!');
  const hero = body?.querySelector('.hero h2')?.textContent || '';
  const isekai = new Set(real.anime
    .filter((a) => (a.th || []).map((i) => real.names[i]).includes('Isekai'))
    .map((a) => a.t));
  check('Konosuba is recommended an isekai first', isekai.has(hero), hero);

  /* Both guards on promotion, asserted against the real catalogue rather than
     a fixture, because both were found there and neither is visible in a small
     one. Sources picked for shape: Konosuba is the case it was built for,
     Berserk has five genres so its top tier holds a single entry, Steins;Gate
     has almost nothing above it and walks the other way, and Tokyo Ravens sits
     deep in the rankings where the tiers are dense. */
  const probe = (title, direction) => JSON.parse(w.eval(`(() => {
    const source = window.__ranked().find((a) => a.title.startsWith(${JSON.stringify(title)}));
    const buckets = window.__collectTiers(source, ${JSON.stringify(direction)}, new Set());
    const from = window.__positionOf(source);
    const distance = (a) => Math.abs(window.__positionOf(a) - from);
    return JSON.stringify(buckets.map((bucket, tier) => ({
      tier,
      natural: bucket.filter((a) => (a.matchGenres ?? tier) >= tier).map(distance),
      promoted: bucket.filter((a) => (a.matchGenres ?? tier) < tier).map(distance),
    })));
  })()`));

  const sources = [
    ['Kono Subarashii', 'up'], ['Kenpuu Denki Berserk', 'down'],
    ['Steins;Gate', 'down'], ['Tokyo Ravens', 'up'],
    // Both of these have an empty tier directly above a populated one holding
    // promotable candidates, which is the only situation the empty-tier guard
    // can fire in. Roughly one source in eleven is shaped this way, and the
    // four above are not among them -- without these two, that check passes
    // whether the guard is there or not.
    ['Made in Abyss', 'up'], ['Monster', 'up'],
  ];

  let invented = [];
  let overreached = [];
  for (const [title, direction] of sources) {
    for (const { tier, natural, promoted } of probe(title, direction)) {
      if (!promoted.length) continue;
      // An empty tier is never conjured out of promotions: with no natural
      // member there is no reach to measure against, and a lone promoted entry
      // ahead of a dense tier is the Arslan Senki bug.
      if (!natural.length) invented.push(`${title} tier ${tier}`);
      // And promotion may densify a tier, never extend it. Unbounded, this let
      // Arslan Senki (528 places from Berserk) and Grancrest Senki (1,376)
      // into a tier whose only natural member was 258 away; the walk took them
      // first, raced the frontier to the far end, and monotonicity deleted the
      // near neighbours below.
      else if (Math.max(...promoted) > Math.min(...natural)) {
        overreached.push(`${title} tier ${tier}: ${Math.max(...promoted)} > ${Math.min(...natural)}`);
      }
    }
  }
  check('promotion never invents an empty tier', invented.length === 0, invented.join('; '));
  check('a promoted entry never reaches further than the tier it joins',
    overreached.length === 0, overreached.join('; '));

  /* The tier an entry sits in and the genres it actually shares are no longer
     the same number, and the note must report the second. Claiming a shared
     genre that is really a shared theme would be a lie on the card. */
  const overclaims = w.eval(`(() => {
    const source = window.__ranked().find((a) => a.title.startsWith('Kono Subarashii'));
    const buckets = window.__collectTiers(source, 'up', new Set());
    return buckets.flatMap((bucket, tier) => bucket
      .filter((a) => (a.matchGenres ?? 0) > source.genres.length
        || a.genres.filter((g) => source.genres.includes(g)).length !== a.matchGenres)
      .map((a) => a.title)).length;
  })()`);
  check('a promoted entry never overstates the genres it shares', overclaims === 0, `${overclaims}`);
}

/* ---------- length mismatch ---------- */

console.log('\n--- REAL catalogue: length mismatch ---');
{
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const dom = makeDom(real);
  await sleep(500);
  const w = dom.window;

  /* A show still airing five years on is long-running whatever its missing
     episode count says. Ignoring that group was tried and broke the rule on
     the spot: Overlord demoted Dragon Ball at 153 episodes and One Piece, at
     more than a thousand, took the slot it vacated. */
  const onePiece = w.__ranked().find((a) => a.title === 'One Piece');
  const conan = w.__ranked().find((a) => a.title.startsWith('Meitantei Conan'));
  check('One Piece has no episode count on record', !onePiece?.episodes, `${onePiece?.episodes}`);
  check('but it is still counted as long-running', w.__lengthOf(onePiece) > 500,
    `${w.__lengthOf(onePiece)}`);
  check('and so is Meitantei Conan', w.__lengthOf(conan) > 500, `${w.__lengthOf(conan)}`);

  /* A show that started airing recently is genuinely ambiguous -- three
     episodes in looks identical to a thousand -- so it gets no penalty, the
     same rule as a missing demographic. */
  const young = w.__ranked().find((a) => !a.episodes && a.status === 'air'
    && a.year >= new Date().getFullYear() - 2);
  if (young) {
    check('a recently-started airing show is left unknown, not guessed at',
      w.__lengthOf(young) === null, `${young.title} -> ${w.__lengthOf(young)}`);
  }

  /* Which tier a named show lands in, searched across the whole bucket.
     The first version of this looked only at the first 12 entries of the top
     tier, and it passed with the rule deleted -- GATE's top tier is dense, 31
     shows share all three of its genres within 100 places, and Naruto sits at
     283, so it was never inside the window being examined. A guard that cannot
     see the thing it guards is worse than no guard. */
  const tierOf = (title, direction, target) => JSON.parse(w.eval(`(() => {
    const source = window.__ranked().find((a) => a.title.startsWith(${JSON.stringify(title)}));
    const buckets = window.__collectTiers(source, ${JSON.stringify(direction)}, new Set());
    let found = null;
    buckets.forEach((bucket, tier) => {
      if (bucket.some((a) => a.title === ${JSON.stringify(target)})) found = tier;
    });
    return JSON.stringify({ tier: found, top: buckets.length - 1 });
  })()`));

  /* GATE is 12 episodes and its fifth result was Naruto at 220 -- an exact
     three-genre match arriving in correct proximity order, which is exactly
     why nothing else could catch it. */
  const naruto = tierOf('Gate: Jieitai', 'up', 'Naruto');
  check('a 220-episode series is demoted out of a 12-episode show\'s top tier',
    naruto.tier !== null && naruto.tier < naruto.top,
    `Naruto in tier ${naruto.tier} of ${naruto.top}`);

  /* The other half of the rule, and the reason it is a ratio rather than an
     episode count: Haikyuu!! legitimately reaches long sports series, and a
     blunt penalty would wreck that chain. 25 to 101 episodes is 4x; GATE to
     Naruto is 18x. */
  const slamDunk = tierOf('Haikyuu!!', 'up', 'Slam Dunk');
  const ippo = tierOf('Haikyuu!!', 'up', 'Hajime no Ippo');
  check('but Haikyuu!! keeps Slam Dunk in its top tier',
    slamDunk.tier === slamDunk.top, `tier ${slamDunk.tier} of ${slamDunk.top}`);
  check('and Hajime no Ippo too',
    ippo.tier === ippo.top, `tier ${ippo.tier} of ${ippo.top}`);
}

/* ---------- the vote backend ---------- */

console.log('\n--- vote backend ---');
{
  const shared = await import('../functions/api/_shared.js');
  const { tally, animeId, voterId, RECOMMEND_AT, VOTE_FLOOR, MAX_IDS, MAX_BATCH } = shared;

  /* The threshold is applied here, at read time, rather than stored. That is
     what makes it retunable: moving from 7 to 8 is a one-line change and no
     data is lost, where a stored verdict would mean asking everyone again. */
  check('a score of 7 counts as a recommendation', RECOMMEND_AT === 7, `${RECOMMEND_AT}`);
  const spread = tally({ s5: 1, s6: 1, s7: 1, s8: 1, s9: 1, s10: 1, up: 0, down: 0 });
  check('scores at or above the threshold count, below it do not',
    spread.yes === 4 && spread.total === 6, JSON.stringify(spread));

  /* Nothing is excluded from the denominator, and that was measured rather
     than assumed. Treating 5 and 6 as neutral reads well -- MyAnimeList calls
     6 "Fine" -- but it pushed 46% of the catalogue above 90% and squeezed the
     range out, because the 1-4 tail is thin: people who dislike a show mostly
     drop it without scoring. A 6 is not a recommendation, so it counts as
     somebody who would not recommend it. */
  check('a middling score counts against the title rather than vanishing',
    tally({ s5: 10, s6: 10 }).total === 20 && tally({ s5: 10, s6: 10 }).yes === 0,
    JSON.stringify(tally({ s5: 10, s6: 10 })));
  check('and no neutral band is left behind on the server',
    shared.NEUTRAL_FROM === undefined, `NEUTRAL_FROM = ${shared.NEUTRAL_FROM}`);

  /* The client applies the identical rule to MyAnimeList's histogram, and the
     card can show both figures at once -- two numbers on one row computed by
     different rules would be worse than either alone. */
  const appSrc = readFileSync(`${ROOT}/app.js`, 'utf8');
  check('and app.js agrees with the server on the threshold',
    /const RECOMMEND_AT = 7;/.test(appSrc) && !/const NEUTRAL_FROM/.test(appSrc),
    'app.js constants disagree with the server');

  /* Thumbs and imported scores pool into one figure -- the point of importing
     is that far more titles clear the floor -- while staying separate in the
     row underneath, so they can be split again without new data. */
  const pooled = tally({ s8: 2, s3: 1, up: 3, down: 1 });
  check('thumbs and imported scores pool into one figure',
    pooled.yes === 5 && pooled.total === 7, JSON.stringify(pooled));
  check('a title nobody has voted on tallies to nothing',
    tally(null).total === 0 && tally({}).total === 0);

  /* A percentage from a handful of votes looks like data and is not. */
  check('a floor is set before any percentage is shown', VOTE_FLOOR >= 30, `${VOTE_FLOOR}`);

  // Ids arrive from the network, so anything that is not a plain positive
  // integer has to be refused rather than reaching a query.
  check('sane anime ids are accepted', animeId(5114) === 5114 && animeId('21') === 21);
  const junk = [0, -1, 1.5, 1e12, 'abc', '', null, undefined, {}, '1; DROP TABLE votes'];
  check('everything else is refused', junk.every((v) => animeId(v) === null),
    junk.filter((v) => animeId(v) !== null).join(', '));

  // The voter id is opaque -- a random string the browser invented -- so the
  // only question is whether its shape could become a storage problem.
  check('a plausible voter id is accepted', voterId('a'.repeat(24)) !== null);
  const badVoters = ['short', 'x'.repeat(200), '', null, 42, 'has spaces', "quote'd"];
  check('a malformed or oversized voter id is refused',
    badVoters.every((v) => voterId(v) === null),
    badVoters.filter((v) => voterId(v) !== null).join(', '));

  // Both caps exist for the free tier's 10ms CPU budget, not for tidiness.
  check('a single request cannot ask about the whole catalogue',
    MAX_IDS > 0 && MAX_IDS <= 100, `${MAX_IDS}`);
  check('a bulk import is capped so the client has to chunk',
    MAX_BATCH > 0 && MAX_BATCH <= 500, `${MAX_BATCH}`);
}

{
  /* The read path must never scan the votes table. A title with 5,000 votes
     would cost 5,000 row reads on every card view, and the free allowance is
     five million a day -- a few hundred visitors would exhaust it. The
     pre-aggregated table is what keeps that at one row. */
  const ratings = readFileSync(`${ROOT}/functions/api/ratings.js`, 'utf8');
  check('the read path selects from the aggregate, not from votes',
    /FROM ratings/.test(ratings) && !/FROM votes/.test(ratings));
  check('and it is cached at the edge so most views never reach the database',
    /s-maxage=/.test(ratings) && /cache-control/.test(ratings));
  /* Same rule as a failed catalogue fetch: the site worked without ratings
     yesterday and has to keep working without them today. */
  check('a missing or broken database degrades instead of erroring',
    /unavailable: true/.test(ratings) && /!env\.VOTES/.test(ratings));

  const schema = readFileSync(`${ROOT}/schema.sql`, 'utf8');
  check('the schema keeps the raw signal as well as the aggregate',
    /CREATE TABLE IF NOT EXISTS votes/.test(schema)
    && /CREATE TABLE IF NOT EXISTS ratings/.test(schema));
  check('and the aggregate is a histogram, so the threshold can move later',
    /\bs7\b/.test(schema) && /\bs10\b/.test(schema));

  /* Functions are scoped to /api/* so the rest of the site is served exactly
     as it was -- static files, no runtime in front of them. Without this,
     Pages puts a Function in front of every request on the site. */
  /* Pages routes a method only if something handles it, so an unrouted method
     falls through to the static handler and answers 200 with the SPA's
     index.html. A JSON endpoint replying with a web page reads as healthy to a
     monitor and baffling to a person. Found by calling the deployed endpoint,
     not by reading the code. */
  check('a HEAD request is answered by the endpoint, not the SPA',
    /export async function onRequestHead/.test(ratings));

  const vote = readFileSync(`${ROOT}/functions/api/vote.js`, 'utf8');
  check('and the vote endpoint refuses a wrong method rather than falling through',
    /export function onRequest\(/.test(vote) && /takes POST/.test(vote) && /405/.test(vote));
  /* One entry point that dispatches, not a method-specific export plus a
     catch-all: exporting both leaves it ambiguous which Pages prefers, and
     that is not worth depending on. */
  check('and it has one entry point rather than two that might disagree',
    !/export async function onRequestPost/.test(vote));

  const routes = JSON.parse(readFileSync(`${ROOT}/_routes.json`, 'utf8'));
  check('Functions run only for /api/, leaving the site static',
    Array.isArray(routes.include) && routes.include.length === 1
    && routes.include[0] === '/api/*', JSON.stringify(routes));

  const robots = readFileSync(`${ROOT}/robots.txt`, 'utf8');
  check('crawlers are kept off the endpoints and the schema',
    /Disallow: \/api\//.test(robots) && /Disallow: \/schema\.sql/.test(robots));
}

/* ---------- the vote SQL, run for real ---------- */

console.log('\n--- vote SQL ---');
{
  /* D1 is SQLite, and Node ships SQLite, so the schema and the exact
     statements from the vote endpoint can be executed here rather than
     eyeballed. Nothing is mocked: this is schema.sql applied verbatim and the
     same upserts the endpoint issues. No new dependency -- node:sqlite is
     built in. */
  const { DatabaseSync } = await import('node:sqlite');
  const { tally } = await import('../functions/api/_shared.js');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(`${ROOT}/schema.sql`, 'utf8'));
  check('schema.sql applies cleanly to a real SQLite database', true);

  const now = 1700000000;
  const castVote = (voter, anime, { score = null, liked = null }) => {
    const to = liked === 1 ? 'up' : liked === 0 ? 'down' : `s${score}`;
    const was = db.prepare('SELECT score, liked FROM votes WHERE voter = ? AND anime = ?').get(voter, anime);
    const from = was
      ? (was.liked === 1 ? 'up' : was.liked === 0 ? 'down' : `s${was.score}`)
      : null;
    if (from === to) return false;
    db.prepare(`INSERT INTO votes (voter, anime, score, liked, source, updated)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(voter, anime) DO UPDATE SET
                  score = excluded.score, liked = excluded.liked,
                  source = excluded.source, updated = excluded.updated`)
      .run(voter, anime, score, liked, score === null ? 'thumb' : 'import', now);
    if (from) {
      db.prepare(`UPDATE ratings SET ${from} = MAX(${from} - 1, 0), updated = ? WHERE anime = ?`).run(now, anime);
    }
    db.prepare(`INSERT INTO ratings (anime, ${to}, updated) VALUES (?, 1, ?)
                ON CONFLICT(anime) DO UPDATE SET ${to} = ${to} + 1, updated = excluded.updated`)
      .run(anime, now);
    return true;
  };

  const readBack = (anime) => tally(db.prepare('SELECT * FROM ratings WHERE anime = ?').get(anime));

  // three imported scores and two thumbs on the same title
  castVote('voter-aaaaaaaaaaaaaaa', 5114, { score: 9 });
  castVote('voter-bbbbbbbbbbbbbbb', 5114, { score: 8 });
  castVote('voter-ccccccccccccccc', 5114, { score: 4 });
  castVote('voter-ddddddddddddddd', 5114, { liked: 1 });
  castVote('voter-eeeeeeeeeeeeeee', 5114, { liked: 0 });
  check('votes and thumbs aggregate into one tally',
    JSON.stringify(readBack(5114)) === JSON.stringify({ yes: 3, total: 5 }),
    JSON.stringify(readBack(5114)));

  /* The same person voting twice must replace, never add -- otherwise anyone
     could inflate a title by clicking repeatedly. */
  const again = castVote('voter-aaaaaaaaaaaaaaa', 5114, { score: 9 });
  check('voting the same way twice changes nothing', again === false
    && JSON.stringify(readBack(5114)) === JSON.stringify({ yes: 3, total: 5 }),
    JSON.stringify(readBack(5114)));

  /* Changing your mind has to move the count out of the old bucket as well as
     into the new one. Missing the decrement is the classic aggregate bug: the
     total drifts upward and never comes back. */
  castVote('voter-aaaaaaaaaaaaaaa', 5114, { score: 3 });
  check('changing a vote moves it rather than double-counting',
    JSON.stringify(readBack(5114)) === JSON.stringify({ yes: 2, total: 5 }),
    JSON.stringify(readBack(5114)));

  const rows = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE anime = ?').get(5114);
  check('and one person still holds exactly one row', rows.n === 5, `${rows.n}`);

  /* The aggregate must agree with the rows behind it, which is the whole
     reason the aggregate is safe to read instead of the votes table. */
  const raw = db.prepare('SELECT score, liked FROM votes WHERE anime = ?').all(5114);
  const fromRaw = raw.reduce((acc, r) => {
    const yes = r.liked === 1 || (r.score !== null && r.score >= 7);
    return { yes: acc.yes + (yes ? 1 : 0), total: acc.total + 1 };
  }, { yes: 0, total: 0 });
  check('the aggregate agrees with a scan of the raw votes',
    JSON.stringify(fromRaw) === JSON.stringify(readBack(5114)),
    `raw ${JSON.stringify(fromRaw)} vs aggregate ${JSON.stringify(readBack(5114))}`);

  db.close();
}

/* ---------- the recommend row ---------- */

console.log('\n--- the recommend row ---');
{
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const heroId = () => Number(dom.window.eval('(() => { const s = window.__peek ? window.__peek() : null; return s ? s.list[s.index].id : 0; })()'));

  /* Three states for one line of text, all arriving after the card is on
     screen: nothing, a bare count, and a percentage. Any of them changing the
     row's height would move every button under it. */
  let dom = makeDom(real, {
    ratings: { ratings: {}, floor: 30, recommendAt: 7 },
  });
  await sleep(400);
  let body = await pickAndRecommend(dom, 'Fullmetal Alchemist: Brotherhood');
  await sleep(300);
  check('the recommend row is always rendered', !!body?.querySelector('.recommend'));
  check('and it sits inside the card, not below it with the notes',
    !!body?.querySelector('.hero .recommend'));
  /* It used to say nothing here, because nobody on this site had rated the
     title. It now shows MyAnimeList's figure, named as theirs -- which is the
     whole point of seeding: the row was empty on essentially every card and
     would have stayed that way for years. */
  check('it falls back to the MyAnimeList figure when this site has none',
    /would recommend/.test(body?.querySelector('.recommend-figure')?.textContent || '')
    && /MyAnimeList/.test(body?.querySelector('.recommend-figure')?.textContent || ''),
    body?.querySelector('.recommend-figure')?.textContent);
  check('and the ask is there either way',
    body?.querySelectorAll('.vote-btn').length === 2);

  /* Below the floor it reports the count rather than a percentage. "100% would
     recommend" off one vote looks like data and is not. */
  const id = Number(body.querySelector('.vote-btn')?.dataset.id);
  dom = makeDom(real, { ratings: { ratings: { [id]: { yes: 2, total: 3 } }, floor: 30, recommendAt: 7 } });
  await sleep(400);
  body = await pickAndRecommend(dom, 'Fullmetal Alchemist: Brotherhood');
  await sleep(300);
  /* "3 ratings so far" beside a figure built on a million votes is noise. The
     site's own count is held back until it clears the floor and can stand as a
     percentage of its own. */
  check('a handful of local votes is not mentioned beside the borrowed figure',
    !/3 ratings so far/.test(body?.textContent || '')
    && /MyAnimeList/.test(body?.querySelector('.recommend-figure')?.textContent || ''),
    body?.querySelector('.recommend-figure')?.textContent);

  dom = makeDom(real, { ratings: { ratings: { [id]: { yes: 121, total: 147 } }, floor: 30, recommendAt: 7 } });
  await sleep(400);
  body = await pickAndRecommend(dom, 'Fullmetal Alchemist: Brotherhood');
  await sleep(300);
  /* Above the floor both are shown, each attributed. Presenting one number
     without saying whose it is would be the dishonest version. */
  const both = body?.querySelector('.recommend-figure')?.textContent || '';
  check('at the floor this site\'s own percentage joins MyAnimeList\'s',
    /82% here \(147\)/.test(both) && /MyAnimeList/.test(both), both);

  /* Same rule as a failed synopsis fetch and a failed catalogue fetch: the
     site worked without ratings before they existed and has to keep working
     without them. The row stays, holding its height, and says nothing. */
  dom = makeDom(real, { ratings: null });        // the stub rejects
  await sleep(400);
  body = await pickAndRecommend(dom, 'Fullmetal Alchemist: Brotherhood');
  await sleep(300);
  /* The seeded figure comes from the catalogue, so it survives the ratings
     endpoint being down entirely -- which is a better failure than the row
     going quiet, and costs no request. */
  check('a failed ratings request leaves the row in place, still showing MAL',
    !!body?.querySelector('.recommend')
    && /MyAnimeList/.test(body?.querySelector('.recommend-figure')?.textContent || ''),
    body?.querySelector('.recommend-figure')?.textContent);
  check('and the buttons still work when ratings are unavailable',
    body?.querySelectorAll('.vote-btn').length === 2);
}

{
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const sent = [];
  const dom = makeDom(real, {
    ratings: { ratings: {}, floor: 30, recommendAt: 7 },
    onVote: (payload) => sent.push(payload),
  });
  await sleep(400);
  const body = await pickAndRecommend(dom, 'Fullmetal Alchemist: Brotherhood');
  await sleep(300);
  const w = dom.window;

  const yes = body.querySelector('.vote-btn[data-vote="up"]');
  yes.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  check('voting marks the button you chose',
    yes.getAttribute('aria-pressed') === 'true'
    && body.querySelector('.vote-btn[data-vote="down"]').getAttribute('aria-pressed') === 'false');
  check('and sends it', sent.length === 1 && sent[0].liked === true, JSON.stringify(sent));
  /* Anonymous by construction: a random id, no account, nothing that leads
     back to a person. */
  check('with an anonymous id and nothing else',
    /^[A-Za-z0-9_-]{16,64}$/.test(sent[0]?.voter || '')
    && Object.keys(sent[0] || {}).sort().join(',') === 'anime,liked,voter',
    Object.keys(sent[0] || {}).join(','));

  /* The button is the feedback, and it is the part that persists -- your
     answer is kept in wanx:myvotes:v1 so it still shows on the way back.
     The *figure* deliberately does not move: a single local vote is far below
     the floor, and appending "1 rating so far" to a figure built on a million
     would be noise pretending to be progress. */
  check('and the button you pressed shows it immediately',
    yes.getAttribute('aria-pressed') === 'true' && yes.classList.contains('vote-on'),
    yes.outerHTML.slice(0, 90));
  check('while the figure stays put rather than claiming one vote changed it',
    !/1 rating so far/.test(body.querySelector('.recommend-figure')?.textContent || ''),
    body.querySelector('.recommend-figure')?.textContent);

  // Clicking the same answer again must not send a second time.
  yes.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('voting the same way twice sends nothing further', sent.length === 1, `${sent.length}`);

  // Changing your mind moves it rather than adding.
  body.querySelector('.vote-btn[data-vote="down"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('changing your mind sends the new answer', sent.length === 2 && sent[1].liked === false);
  /* Changing your mind moves the answer rather than adding one -- the check
     that matters is the aggregate, and the classic bug here is a total that
     drifts up and never comes back. The buttons swap; the figure, being
     MyAnimeList's, is untouched by either. */
  check('and the answer moves rather than accumulating',
    body.querySelector('.vote-btn[data-vote="down"]')?.getAttribute('aria-pressed') === 'true'
    && body.querySelector('.vote-btn[data-vote="up"]')?.getAttribute('aria-pressed') === 'false',
    body.querySelector('.recommend')?.innerHTML.slice(0, 140));

  check('the vote is remembered in local storage',
    (w.localStorage.getItem('wanx:myvotes:v1') || '').includes('false'),
    w.localStorage.getItem('wanx:myvotes:v1'));
}

/* ---------- sharing imported scores ---------- */

console.log('\n--- sharing imported scores ---');
{
  const real = JSON.parse(readFileSync(`${ROOT}/anime.json`, 'utf8'));
  const known = real.anime.slice(0, 40).map((a) => a.i);

  /* An export shaped like a real one: scored entries, unscored entries, a
     plan-to-watch, and a film that is not in this catalogue. */
  const rows = known.map((id, n) =>
    `<anime><series_animedb_id>${id}</series_animedb_id><my_status>Completed</my_status>`
    + `<my_score>${n % 4 === 0 ? 0 : (n % 10) + 1}</my_score></anime>`);
  rows.push('<anime><series_animedb_id>999999</series_animedb_id><my_status>Completed</my_status><my_score>9</my_score></anime>');
  rows.push('<anime><series_animedb_id>4224</series_animedb_id><my_status>Plan to Watch</my_status><my_score>8</my_score></anime>');
  const XML = `<?xml version="1.0"?><myanimelist>${rows.join('')}</myanimelist>`;

  const dom = makeDom(real);
  await sleep(500);
  const parsed = dom.window.eval(`window.__parseExport(${JSON.stringify(XML)})`);

  /* Zero means "not rated" in a MyAnimeList export, not "terrible". Counting
     those as a 0/10 would drag every figure on the site toward the floor while
     looking like real opinions. */
  check('a score of zero is treated as unrated, not as a nought',
    parsed.scored.every((v) => v.score >= 1), JSON.stringify(parsed.scored.slice(0, 3)));
  check('scores are read from the export at all',
    parsed.scored.length > 0 && parsed.scored.length < parsed.ids.length,
    `${parsed.scored.length} of ${parsed.ids.length}`);
  /* A full list is mostly films, sequels and specials this site does not
     carry. Sending them would waste requests and overstate what someone is
     actually contributing. */
  check('titles outside this catalogue are not sent',
    !parsed.scored.some((v) => v.anime === 999999));
  check('and plan-to-watch is left out of the scores too',
    !parsed.scored.some((v) => v.anime === 4224));
}

{
  const CAT = {
    built: '2026-08-23', count: 3, names: ['Action', 'Fantasy'],
    anime: [501, 502, 503].map((i, n) => ({
      r: n + 1, i, t: `Show ${i}`, ty: 'TV', th: [], d: [], s: 8, g: [0, 1],
      e: 12, y: 2020, m: 100000, im: 'x/y.jpg', st: 'fin',
      stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
    })),
  };
  const XML = `<?xml version="1.0"?><myanimelist>
    <anime><series_animedb_id>501</series_animedb_id><my_status>Completed</my_status><my_score>9</my_score></anime>
    <anime><series_animedb_id>502</series_animedb_id><my_status>Completed</my_status><my_score>4</my_score></anime>
    <anime><series_animedb_id>503</series_animedb_id><my_status>Completed</my_status><my_score>0</my_score></anime>
  </myanimelist>`;

  const boot = (wire) => {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
    dom.window.scrollTo = () => {};
    dom.window.fetch = (t, o) => {
      const href = String(t);
      if (href.includes('api/ratings')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ratings: {}, floor: 30 }) });
      if (href.includes('api/vote')) {
        const body = JSON.parse(o?.body || '{}');
        if (o?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(wire.onForget(body)) });
        wire.onShare(body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ recorded: body.votes.length }) });
      }
      if (href.includes('anilist')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { Page: { media: [] } } }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CAT) });
    };
    dom.window.eval(`${appSource}\nwindow.__offer = offerToShare;\nwindow.__forget = forgetRatings;`);
    return dom;
  };

  /* The question is asked after the file is read and names the real number, so
     it can be checked against your own list. Asking beforehand would mean
     asking about a quantity neither side knows yet. */
  const shared = [];
  let dom = boot({ onShare: (b) => shared.push(b), onForget: () => ({ removed: 0, remaining: 0 }) });
  await sleep(300);
  let w = dom.window;
  w.eval(`window.__offer([{anime:501,score:9},{anime:502,score:4}])`);
  await sleep(80);
  const offer = w.document.getElementById('share-offer');
  check('the offer appears after an import, not before', offer && !offer.hidden);
  check('and names the real number from the file',
    /\b2\b/.test(offer.textContent), offer.textContent.slice(0, 80));
  /* What is not sent, said at the same size as what is. Shrinking that half is
     how a consent box quietly becomes dishonest. */
  check('it says what is not sent as well as what is',
    /Not sent/i.test(offer.textContent) && /your name/i.test(offer.textContent));
  check('and it links to the privacy page', !!offer.querySelector('a[href="privacy"]'));
  check('declining is a real button, not a greyed-out link',
    !!offer.querySelector('[data-share="no"]:not([disabled])'));

  // Declining sends nothing at all.
  offer.querySelector('[data-share="no"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check('declining sends nothing', shared.length === 0, JSON.stringify(shared));
  check('and puts the question away', offer.hidden);

  // Accepting sends exactly the scores, under a random id.
  w.eval(`window.__offer([{anime:501,score:9},{anime:502,score:4}])`);
  await sleep(80);
  w.document.querySelector('[data-share="yes"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  check('accepting sends the scores', shared.length === 1 && shared[0].votes.length === 2,
    JSON.stringify(shared));
  check('under an anonymous id and nothing else',
    /^[A-Za-z0-9_-]{16,64}$/.test(shared[0]?.voter || '')
    && Object.keys(shared[0] || {}).sort().join(',') === 'voter,votes');

  /* The free tier allows 10ms of CPU per request, so a few hundred inserts in
     one call would exceed it. The server caps a batch at 100; this is the
     client half of the same limit. */
  const big = [];
  for (let n = 0; n < 250; n++) big.push({ anime: 500000 + n, score: 8 });
  shared.length = 0;
  w.eval(`window.__offer(${JSON.stringify(big)})`);
  await sleep(80);
  w.document.querySelector('[data-share="yes"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  check('a large list is chunked rather than sent in one request',
    shared.length === 3 && shared.every((b) => b.votes.length <= 100),
    shared.map((b) => b.votes.length).join('+'));
}

{
  /* Removal has the same CPU problem from the other end, so the server works
     in bites and the page keeps asking until nothing is left. The privacy note
     promises this works, and the promise is what makes the consent screen
     credible. */
  const CAT = { built: '2026-08-23', count: 1, names: ['Action'],
    anime: [{ r: 1, i: 501, t: 'Show', ty: 'TV', th: [], d: [], s: 8, g: [0], e: 12, y: 2020, m: 1000, im: 'x.jpg', st: 'fin', stats: { w: 1, c: 80, h: 1, d: 1, p: 1 } }] };
  let left = 250;
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.com/', pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.fetch = (t, o) => {
    const href = String(t);
    if (href.includes('api/vote') && o?.method === 'DELETE') {
      calls.push(JSON.parse(o.body));
      const removed = Math.min(100, left);
      left -= removed;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ removed, remaining: left }) });
    }
    if (href.includes('api/ratings')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ratings: {}, floor: 30 }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(CAT) });
  };
  dom.window.eval(`${appSource}\nwindow.__forget = forgetRatings;\nwindow.__myVotes = () => myVotes.size;`);
  await sleep(300);
  const w = dom.window;
  w.localStorage.setItem('wanx:myvotes:v1', JSON.stringify({ 501: true }));

  const label = w.document.getElementById('watched-count');
  await w.eval('window.__forget(document.getElementById("watched-count"))');
  await sleep(150);

  check('removal keeps asking until the server says nothing is left',
    calls.length === 3, `${calls.length} calls`);
  check('and identifies the voter by the same anonymous id',
    /^[A-Za-z0-9_-]{16,64}$/.test(calls[0]?.voter || '')
    && Object.keys(calls[0] || {}).join(',') === 'voter');
  check('it reports what it removed', /250/.test(label.textContent), label.textContent);
  check('and forgets them locally too', w.__myVotes() === 0 && !w.localStorage.getItem('wanx:myvotes:v1'));
}

{
  /* The page the consent screen points at. Broken or missing, the whole
     arrangement is just a claim. */
  /* Whitespace-normalised before matching: the page is hand-wrapped HTML, so
     any phrase long enough to be worth asserting spans a line break. */
  const privacy = readFileSync(`${ROOT}/privacy.html`, 'utf8').replace(/\s+/g, ' ');
  const index = readFileSync(`${ROOT}/index.html`, 'utf8');
  /* Linked as /privacy, not /privacy.html. Pages serves the file at the
     extensionless path and 308s the other, so naming the .html would make
     every link, the canonical and the sitemap entry point at a redirect. */
  check('the privacy page exists and is linked from the site',
    privacy.length > 500 && index.includes('href="/privacy"'));
  check('and linked at the address Cloudflare actually serves',
    !index.includes('href="privacy.html"')
    && !readFileSync(`${ROOT}/app.js`, 'utf8').includes('href="privacy.html"'));
  for (const [what, pattern] of [
    ['what is kept in the browser', /watched list/i],
    ['what is sent', /only the show ids and your scores/i],
    ['how to take it back', /Remove my ratings/i],
    ['the limit of taking it back', /cleared your browsing data/i],
    ['who else sees an IP', /AniList/],
    ['where to ask', /github\.com\/dvdngyn96-oss\/what-anime-next\/issues/],
  ]) {
    check(`the privacy page covers ${what}`, pattern.test(privacy));
  }
  /* It is content, not source, so it must stay crawlable -- unlike everything
     else in the repo root, which robots.txt disallows by name. */
  const robots = readFileSync(`${ROOT}/robots.txt`, 'utf8');
  check('and it is crawlable, unlike the build scripts beside it',
    !/Disallow: \/privacy/.test(robots));
  const sitemap = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
  check('and listed in the sitemap, being the only other real document',
    sitemap.includes('/privacy<') || sitemap.includes('/privacy</loc>'));
  check('with no redirecting URL left in the sitemap or the canonical',
    !sitemap.includes('/privacy.html') && !privacy.includes('canonical" href="https://whatanimeshouldiwatchnext.com/privacy.html"'));
}


console.log('\n--- a card already shown does not come back ---');
{
  /* Reported by a reader of the r/anime post, in these words: "if you start
     with Re:Zero it'll recommend Mushoku Tensei. If you click Show me another,
     it'll show you Evangelion. If you then click Seen it too, it'll go back to
     Mushoku Tensei."

     Their diagnosis was right. chainHistory is what the walk is told to skip,
     and only two things fed it -- the anchor, and whatever you pressed "Seen
     it too" on. "Show me another" fed it nothing, because it only advances an
     index through a list that was already computed. refreshFromAnchor then
     re-walks and resets the index to 0, putting the skipped-past entries back
     at the top. */
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t) => ({
    r, i, t, g: [0, 1, 2], th: [], d: [], y: 2020, ty: 'TV', s: 8, e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const CAT = {
    built: '2026-08-27', count: 5, names: NAMES,
    anime: [
      mk(1, 700, 'First Match'),
      mk(2, 701, 'Second Match'),
      mk(3, 702, 'Third Match'),
      mk(4, 703, 'Fourth Match'),
      mk(5, 704, 'The Anchor'),
    ],
  };

  const dom = makeDom(CAT);
  const w = dom.window;
  await sleep(200);
  const body = await pickAndRecommend(dom, 'The Anchor');
  const heroTitle = () => body.querySelector('.hero h2')?.textContent?.trim();
  const click = (sel) => body.querySelector(sel)
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  const first = heroTitle();
  click('.hero [data-action="shuffle"]');
  await sleep(120);
  const second = heroTitle();

  check('show me another moves to a different entry',
    Boolean(first) && Boolean(second) && first !== second, `${first} -> ${second}`);

  // Now drop the second. The first must not come back.
  click('.hero [data-action="seen"]');
  await sleep(250);
  const third = heroTitle();

  check('dropping a card does not return you to one already shown',
    third !== first, `${first} -> ${second} -> ${third} (expected not ${first})`);
  check('and it does not return you to the one you just dropped',
    third !== second, `${second} was dropped but came back`);

  /* Keep going: every card seen so far stays gone, which is the part the
     reader predicted gets worse the deeper you go. */
  const seen = new Set([first, second, third]);
  click('.hero [data-action="seen"]');
  await sleep(250);
  const fourth = heroTitle();
  check('and the rule still holds a step deeper',
    !fourth || !seen.has(fourth), `${[...seen].join(' -> ')} -> ${fourth}`);
}

console.log('\n--- an exhausted chain says so ---');
{
  /* When everything matching has been dismissed the walk does not dead-end --
     it retries with an empty history and allows repeats. That is old behaviour
     and the right call, since a dead end is worse than a repeat. But it used
     to be silent, and recording paged-past cards makes it far easier to reach,
     so a silent restart would look exactly like the bug this build fixes. */
  const NAMES = ['Action'];
  const mk = (r, i, t) => ({
    r, i, t, g: [0], th: [], d: [], y: 2020, ty: 'TV', s: 8, e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });
  const CAT = {
    built: '2026-08-27', count: 3, names: NAMES,
    anime: [mk(1, 710, 'Only Match'), mk(2, 711, 'Other Match'), mk(3, 712, 'Anchor Show')],
  };

  const dom = makeDom(CAT);
  const w = dom.window;
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Anchor Show');
  const click = (sel) => body.querySelector(sel)
    ?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const notes = () => [...body.querySelectorAll('.note')].map((n) => n.textContent).join(' ');

  check('nothing says the list restarted before it has',
    !/started again/i.test(notes()), notes().slice(0, 120));

  // Page past one, drop the other: both matches are now dismissed.
  click('.hero [data-action="shuffle"]');
  await sleep(150);
  click('.hero [data-action="seen"]');
  await sleep(300);

  check('a fully dismissed walk still shows a card rather than dead-ending',
    Boolean(body.querySelector('.hero')), body.textContent.slice(0, 120));
  check('and it says the list started over, so a repeat is not read as a bug',
    /started again/i.test(notes()), notes().slice(0, 220) || '(no notes)');
  check('and that note sits below the card, like every other note',
    (() => {
      const heroEl = body.querySelector('.hero');
      const note = [...body.querySelectorAll('.note')]
        .find((n) => /started again/i.test(n.textContent));
      return Boolean(heroEl) && Boolean(note)
        && Boolean(heroEl.compareDocumentPosition(note) & 4);
    })(), 'restart note found above .hero');
}



console.log('\n--- the accent behind white text ---');
{
  /* Build 44 computed the wordmark's contrast from the stylesheet rather than
     eyeballing it, and missed the controls. Every switched-on toggle chip --
     direction, axis, and the "2010 or later" year chip -- is white text on the
     accent, which was 3.91:1 on the light theme and 2.78:1 on the dark, both
     under the 4.5:1 that 13px text needs. --accent-fill is a separate value
     for that one job, so the wordmark red stays tied to --accent and keeps the
     3.20-4.10 band build 44 tuned it to. */
  const css = readFileSync(`${ROOT}/styles.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  const fill = (css.match(/--accent-fill:\s*(#[0-9a-f]{6})/i) || [])[1];
  check('the stylesheet defines --accent-fill', Boolean(fill), fill || '(absent)');

  const WHITE = [255, 255, 255];
  const ratio = fill ? contrast(rgb(fill), WHITE) : 0;
  check('white text on it clears 4.5:1, the bar for text under 18.66px',
    ratio >= 4.5, `${fill} is ${ratio.toFixed(2)}:1`);

  /* It has to stay visible as a chip too, against both page backgrounds --
     passing the text bar by going nearly black would trade one failure for
     another. */
  const lightBg = (css.match(/--bg:\s*(#[0-9a-f]{6})/i) || [])[1];
  const darkBg = (css.match(/--bg:\s*(#[0-9a-f]{6})/ig) || []).length > 1
    ? [...css.matchAll(/--bg:\s*(#[0-9a-f]{6})/ig)][1][1] : null;
  if (fill && lightBg) {
    check('and the chip is still visible on the light page',
      contrast(rgb(fill), rgb(lightBg)) >= 3,
      `${fill} vs ${lightBg} is ${contrast(rgb(fill), rgb(lightBg)).toFixed(2)}:1`);
  }
  if (fill && darkBg) {
    check('and on the dark page',
      contrast(rgb(fill), rgb(darkBg)) >= 3,
      `${fill} vs ${darkBg} is ${contrast(rgb(fill), rgb(darkBg)).toFixed(2)}:1`);
  }

  /* The filled rule must actually use it. Pointing --accent-fill at a passing
     colour while the rule still says var(--accent) would satisfy every check
     above and change nothing on the page. */
  const rule = css.match(/\.direction button\[aria-pressed="true"\]\s*\{([^}]*)\}/);
  check('and the switched-on chip actually uses it',
    Boolean(rule) && /background:\s*var\(--accent-fill\)/.test(rule[1]),
    rule ? rule[1].trim().replace(/\s+/g, ' ') : '(rule not found)');

  /* --accent itself is untouched, so the wordmark keeps its tuning. */
  check('--accent is left alone, so the wordmark palette is unaffected',
    /--accent:\s*#e5484d/i.test(css), 'accent changed');
}


console.log('\n--- importing by username ---');
{
  /* The file export is four steps on MyAnimeList's own site before you reach
     this page, and it is where most people give up. The username route asks
     for one field. The credential cannot go in the browser, so it goes through
     a Function -- which is the whole reason /api/mal-list exists. */
  const mod = await import(`file://${ROOT}/functions/api/mal-list.js`);
  const call = (url, env = {}, fetchImpl = null) => {
    const saved = globalThis.fetch;
    if (fetchImpl) globalThis.fetch = fetchImpl;
    return Promise.resolve(mod.onRequestGet({ request: new Request(url), env }))
      .finally(() => { globalThis.fetch = saved; });
  };
  const BASE = 'https://example.com/api/mal-list';

  // Validation happens before any upstream call, so a bad name costs no quota.
  let reached = false;
  const spy = async () => { reached = true; return new Response('{}', { status: 200 }); };

  let res = await call(`${BASE}?user=`, { MAL_CLIENT_ID: 'x' }, spy);
  check('an empty username is refused', res.status === 400, String(res.status));
  res = await call(`${BASE}?user=not a username!`, { MAL_CLIENT_ID: 'x' }, spy);
  check('and so is one that cannot be a MyAnimeList name', res.status === 400, String(res.status));
  check('neither reached MyAnimeList, so a bad name costs no quota', !reached, 'upstream was called');

  /* No credential configured is not an error. The file importer needs no
     server at all, so it still works -- same rule as a missing votes database
     leaving the site working without ratings. */
  res = await call(`${BASE}?user=someone`, {});
  let body = await res.json();
  check('with no credential set it degrades rather than failing',
    res.status === 200 && body.unavailable === true, JSON.stringify(body));

  /* The two upstream failures worth telling apart. "Not found" for a private
     list would send somebody hunting for a typo that is not there. */
  res = await call(`${BASE}?user=ghost`, { MAL_CLIENT_ID: 'x' },
    async () => new Response('{}', { status: 404 }));
  body = await res.json();
  check('a missing user says so by name',
    res.status === 404 && /No MyAnimeList user called "ghost"/.test(body.error), body.error);

  res = await call(`${BASE}?user=shy`, { MAL_CLIENT_ID: 'x' },
    async () => new Response('{}', { status: 403 }));
  body = await res.json();
  check('a private list says it is private, and names the way round it',
    res.status === 403 && /private/i.test(body.error) && /file import/i.test(body.error),
    body.error);

  /* A credential with a trailing newline -- which is how it arrives if you
     copy the contents of .mal-client-id, a file every build script here reads
     with .trim(). Untrimmed it makes an invalid header value, which throws,
     and on Workers a throw surfaces as a bare "error code: 502" text/plain
     page from the edge. From outside that was indistinguishable from the
     endpoint not being deployed at all. */
  let sent = null;
  res = await call(`${BASE}?user=real`, { MAL_CLIENT_ID: 'abc123\n' }, async (u, o) => {
    sent = o?.headers?.['X-MAL-CLIENT-ID'];
    return new Response(JSON.stringify({ data: [], paging: {} }), { status: 200 });
  });
  check('a credential with a trailing newline is trimmed, not sent raw',
    sent === 'abc123', JSON.stringify(sent));
  check('and the request still succeeds', res.status === 200, String(res.status));

  // A genuinely malformed credential is named rather than left to throw.
  res = await call(`${BASE}?user=real`, { MAL_CLIENT_ID: 'has spaces' },
    async () => new Response('{}', { status: 200 }));
  body = await res.json();
  check('a malformed credential says so instead of throwing',
    res.status === 500 && /malformed/i.test(body.error), body.error);

  /* Nothing may reach the edge as an unhandled throw. */
  res = await call(`${BASE}?user=real`, { MAL_CLIENT_ID: 'abc123' }, () => {
    throw new Error('boom');
  });
  body = await res.json();
  check('an unexpected throw still answers with JSON, not a bare edge error',
    res.status >= 500 && typeof body.error === 'string', JSON.stringify(body));

  // The happy path, slimmed to three numbers a row.
  const upstream = {
    data: [
      { node: { id: 100, title: 'x', main_picture: { medium: 'a' } }, list_status: { status: 'completed', score: 9 } },
      { node: { id: 101 }, list_status: { status: 'plan_to_watch', score: 0 } },
      { node: { id: 102 }, list_status: { status: 'dropped', score: 0 } },
    ],
    paging: {},
  };
  res = await call(`${BASE}?user=real`, { MAL_CLIENT_ID: 'x' },
    async () => new Response(JSON.stringify(upstream), { status: 200 }));
  body = await res.json();
  check('a good list comes back as compact rows',
    JSON.stringify(body.entries) === JSON.stringify([[100, 'completed', 9], [101, 'plan_to_watch', 0], [102, 'dropped', 0]]),
    JSON.stringify(body.entries));
  check('and drops the poster URLs MyAnimeList sends whatever fields asks for',
    !JSON.stringify(body).includes('main_picture'), JSON.stringify(body).slice(0, 120));
  check('with no next page when there is none', body.next === null, String(body.next));

  /* Paging is by offset because the 10ms CPU budget will not parse a whole
     large list in one request. The client loops on `next`. */
  res = await call(`${BASE}?user=real&offset=500`, { MAL_CLIENT_ID: 'x' },
    async (u) => {
      check('the offset is passed upstream', /offset=500/.test(String(u)), String(u));
      return new Response(JSON.stringify({ data: upstream.data, paging: { next: 'more' } }), { status: 200 });
    });
  body = await res.json();
  check('and the next offset resumes where this page ended', body.next === 503, String(body.next));
}

console.log('\n--- the two importers agree on what counts ---');
{
  /* The export XML and the API spell the same four statuses differently --
     "On-Hold" against "on_hold" -- so the two paths cannot share one set. If
     they drift apart the failure is silent: an unrecognised status is treated
     as plan-to-watch and the title stays recommendable, which reads as the
     import having quietly skipped things. */
  const dom = makeDom(SYNTHETIC);
  const w = dom.window;
  await sleep(200);

  const rows = [
    [100, 'completed', 9],
    [101, 'watching', 0],
    [102, 'on_hold', 7],
    [103, 'dropped', 3],
    [104, 'plan_to_watch', 8],
  ];
  const out = w.__readListRows(rows);

  check('all four watched statuses are recognised in the API spelling',
    out.ids.length === 4 && !out.ids.includes(104), JSON.stringify(out.ids));
  check('plan-to-watch is left out, as it is for the file',
    out.planned === 1, String(out.planned));
  /* Zero means "not rated", not "terrible" -- the same trap as the XML's
     my_score, and it must be caught in both places. */
  check('a zero score is not treated as an opinion',
    out.scored.every((s) => s.score >= 1), JSON.stringify(out.scored));
  check('and a plan-to-watch score is never collected, even when set',
    !out.scored.some((s) => s.anime === 104), JSON.stringify(out.scored));
}


console.log('\n--- the ratings row, seeded from MyAnimeList ---');
{
  /* The row exists to say "what other people thought", and until now it said
     nothing on almost every card: a percentage needs 30 ratings and the site
     has nowhere near that across 4,427 titles. MyAnimeList's own score
     histogram answers the same question today, from millions of votes. */
  const G = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, g: [0, 1, 2], th: [], d: [], y: 2020, ty: 'TV', s: 8, e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
    ...extra,
  });

  // Frieren's real distribution, as tenths of a percent, lowest score first.
  const FRIEREN = [32, 2, 2, 3, 7, 13, 38, 116, 258, 530];

  const CAT = {
    built: '2026-08-28', count: 3, names: G,
    anime: [
      mk(1, 900, 'Has A Distribution', { sd: FRIEREN, sv: 928582 }),
      mk(2, 901, 'All Shrugs', { sd: [0, 0, 0, 0, 500, 500, 0, 0, 0, 0], sv: 1000 }),
      mk(3, 902, 'No Distribution'),
    ],
  };

  const dom = makeDom(CAT);
  const w = dom.window;
  await sleep(250);

  const v = w.__malVerdict(w.__ranked().find((a) => a.id === 900));
  /* Every score counts. 875,007 of 928,582 scored it 7 or better, so 94%.
     Excluding the 5s and 6s would report 96%, and doing that catalogue-wide
     put the median show at 89% -- see the threshold note in CLAUDE.md. */
  check('every score counts toward the figure, none are excluded',
    v && v.pct === 94, JSON.stringify(v));
  check('and the scorer count is the real one, not the rounded shares',
    v && v.scorers === 928582, JSON.stringify(v));

  /* A show rated entirely 5s and 6s is one nobody would recommend, and says
     so, rather than vanishing. */
  check('a title rated only 5s and 6s reports 0%, not nothing',
    w.__malVerdict(w.__ranked().find((a) => a.id === 901))?.pct === 0,
    JSON.stringify(w.__malVerdict(w.__ranked().find((a) => a.id === 901))));

  /* Thin data is suppressed, the same rule the site applies to its own votes.
     Nothing in the catalogue is near this today, but a rebuild can add a show
     that aired last week. */
  check('a histogram from too few scorers yields no figure',
    w.__malVerdict({ sd: [0,0,0,0,0,0,0,0,0,1000], sv: 12 }) === null,
    JSON.stringify(w.__malVerdict({ sd: [0,0,0,0,0,0,0,0,0,1000], sv: 12 })));
  check('but a real one just above the floor still counts',
    w.__malVerdict({ sd: [0,0,0,0,0,0,0,0,0,1000], sv: 40 })?.pct === 100,
    JSON.stringify(w.__malVerdict({ sd: [0,0,0,0,0,0,0,0,0,1000], sv: 40 })));

  check('a title with no histogram yields none either',
    w.__malVerdict(w.__ranked().find((a) => a.id === 902)) === null, 'expected null');
  check('and neither does a live AniList find, which has no such field',
    w.__malVerdict({ id: 1, genres: [] }) === null, 'expected null');

  /* Named as MyAnimeList's, always. It is not this site's community speaking,
     and presenting borrowed numbers as your own is noticed exactly once. */
  const text = w.__recommendText(900);
  check('the figure names MyAnimeList as the source',
    /MyAnimeList/.test(text), text);
  check('and reports it compactly rather than to the digit',
    /929k/.test(text) && !/928,582/.test(text), text);
  /* At 360px the row leaves 229px for the figure and the full sentence needs
     242 -- so the ellipsis would eat "MyAnimeList", which is the one part that
     must survive. "would" is the only word that can go without losing a fact.
     jsdom has no layout, so this guards the mechanism rather than the pixels. */
  const figHtml = w.__recommendFigure(900);
  check('the figure wraps "would" so a narrow screen can drop it',
    /<span class="figure-would">would <\/span>/.test(figHtml), figHtml);
  check('and everything load-bearing survives without it',
    /94%/.test(figHtml) && /929k/.test(figHtml) && /MyAnimeList/.test(figHtml)
      && figHtml.replace(/<span class="figure-would">would <\/span>/, '')
        === '94% recommend · 929k on MyAnimeList',
    figHtml.replace(/<span class="figure-would">would <\/span>/, ''));
  const cssNarrow = readFileSync(`${ROOT}/styles.css`, 'utf8');
  check('and the stylesheet actually hides it under 400px',
    /@media \(max-width: 400px\)[^}]*\{[\s\S]*?\.figure-would\s*\{\s*display:\s*none/.test(cssNarrow),
    'no .figure-would rule inside a 400px block');

  check('a title with no histogram says nothing, as before',
    w.__recommendText(902) === '', JSON.stringify(w.__recommendText(902)));
}

console.log('\n--- the row still fits, and the card still cannot move ---');
{
  const G = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, g: [0, 1, 2], th: [], d: [], y: 2020, ty: 'TV', s: 8, e: 12,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
    ...extra,
  });
  const CAT = {
    built: '2026-08-28', count: 2, names: G,
    anime: [
      mk(1, 910, 'Rich Entry', { sd: [32, 2, 2, 3, 7, 13, 38, 116, 258, 530], sv: 928582 }),
      mk(2, 911, 'Sparse Entry'),
    ],
  };

  const dom = makeDom(CAT);
  await sleep(250);
  const body = await pickAndRecommend(dom, 'Sparse Entry');

  /* The row is a reserved height holding a figure that arrives late. Seeding
     it from the catalogue means it is filled synchronously now, which must not
     have turned it into something that grows. */
  const row = body.querySelector('.recommend');
  check('the recommend row is still rendered unconditionally', Boolean(row),
    'no .recommend in the card');
  check('and still holds both the figure and the ask',
    Boolean(row?.querySelector('.recommend-figure'))
      && Boolean(row?.querySelector('[data-action="vote"]')),
    row?.innerHTML.slice(0, 120));

  const css = readFileSync(`${ROOT}/styles.css`, 'utf8');
  const rule = css.match(/\.recommend\s*\{([^}]*)\}/);
  check('the row keeps a fixed height rather than a minimum',
    Boolean(rule) && /height:\s*30px/.test(rule[1]) && !/min-height/.test(rule[1]),
    rule ? rule[1].trim().replace(/\s+/g, ' ') : '(rule not found)');
  const figure = css.match(/\.recommend-figure\s*\{([^}]*)\}/);
  check('and a longer figure is clipped rather than allowed to wrap',
    Boolean(figure) && /text-overflow:\s*ellipsis/.test(figure[1])
      && /white-space:\s*nowrap/.test(figure[1]),
    figure ? figure[1].trim().replace(/\s+/g, ' ') : '(rule not found)');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
