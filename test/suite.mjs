import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const ROOT = 'C:/Users/David/Downloads/what-anime-next';
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

function makeDom(catalogue, { url = 'https://example.com/', anilist = ANILIST_HIT, detail = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url, pretendToBeVisual: true });
  dom.window.scrollTo = () => {};
  dom.window.fetch = (target, options) => {
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
  dom.window.eval(`${appSource}\nwindow.__ranked = () => ranked;`);
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
  check('URL is shareable', w.location.search === '?id=106&dir=up', w.location.search);

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

  // A brand new search must forget the dismissals.
  const input = w.document.getElementById('search-input');
  w.document.getElementById('home-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(80);
  input.value = 'Beta Show';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(400);
  w.document.querySelector('#suggestions .suggestion').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  await sleep(200);
  check('a fresh search resets the history',
    body.querySelector('.hero h2')?.textContent === 'Alpha Show',
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
  const NAMES = ['Action', 'Fantasy', 'Romance'];
  const mk = (r, i, t, extra = {}) => ({
    r, i, t, s: 8, g: [0, 1, 2], th: [], d: [], ty: 'TV', e: 12, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 }, ...extra,
  });

  const CAT = {
    built: '2026-07-30', count: 3, names: NAMES,
    providers: ['Netflix', 'Crunchyroll', 'Hulu'],
    anime: [
      mk(1, 970, 'Streams Both Regions', { tm: 111, wp: { u: [0, 2], c: [0] } }),
      mk(2, 971, 'Matched But Not Streaming', { tm: 222 }),
      mk(3, 972, 'Source Show', { tm: 333, wp: { u: [1] } }),
    ],
  };

  const dom = makeDom(CAT);
  await sleep(200);
  const body = await pickAndRecommend(dom, 'Source Show');
  const w = dom.window;
  const services = () => [...body.querySelectorAll('.watch .service')].map((s) => s.textContent);

  // Climbing from #3 reaches #2 first — the matched-but-unavailable one.
  check('a title with no listing says so rather than nothing',
    /Not streaming in/.test(body.querySelector('.watch')?.textContent || ''),
    body.querySelector('.watch')?.textContent);
  check('it still links out for that title',
    /themoviedb\.org\/tv\/222\/watch\?locale=US/.test(body.querySelector('.watch-more')?.getAttribute('href') || ''),
    body.querySelector('.watch-more')?.getAttribute('href'));

  body.querySelector('.hero [data-action="shuffle"]')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);

  check('streaming services are listed',
    services().includes('Netflix') && services().includes('Hulu'), services().join(', '));
  check('the link carries the right title and country',
    /themoviedb\.org\/tv\/111\/watch\?locale=US/.test(body.querySelector('.watch-more')?.getAttribute('href') || ''),
    body.querySelector('.watch-more')?.getAttribute('href'));

  body.querySelector('[data-action="region"]')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  check('switching country changes the listing',
    services().includes('Netflix') && !services().includes('Hulu'), services().join(', '));
  check('the country choice is remembered',
    w.localStorage.getItem('wanx:region') === 'c', w.localStorage.getItem('wanx:region'));
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
    check('recommendation shares all three genres',
      ['Action', 'Fantasy', 'Romance'].every((g) => heroGenres.includes(g)), heroGenres.join(', '));

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
    };
  };

  const rich = await shapeOf({ bn: 'a/b.jpg', tm: 1234, wp: { u: [0] } }, 'rich');
  const bare = await shapeOf({}, 'bare');

  for (const part of ['banner', 'watch', 'trailer', 'synopsis']) {
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

/* ---------- link previews and crawler files ---------- */
/* A wrong og:image fails silently — the scraper simply shows no picture, and
   you find out from someone else's timeline. These assert the two things that
   go wrong in a way nobody would notice locally: a relative image URL, and a
   declared size that no longer matches the file on disk. */

console.log('\n--- link previews ---');
{
  const head = new JSDOM(html).window.document;
  const meta = (sel) => head.querySelector(sel)?.getAttribute('content') ?? '';
  const SITE = 'https://what-anime-next.pages.dev';

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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
