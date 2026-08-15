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
  const mk = (r, i, t, th, d) => ({
    r, i, t, th, d, s: 8, g: [0, 1], ty: 'TV', e: 24, y: 2013,
    m: 200000, im: 'x/y.jpg', st: 'fin', stats: { w: 10, c: 8000, h: 50, d: 500, p: 10 },
  });

  const NEAR = {
    built: '2026-07-25', count: 8, names: NAMES,
    anime: [
      mk(1, 800, 'Source Show', [2], [3]),          // Military + Shounen
      mk(2, 801, 'Near Neighbour', [], []),         // genres only, 1 place away
      mk(3, 802, 'Filler A', [], []),
      mk(4, 803, 'Filler B', [], []),
      mk(5, 804, 'Filler C', [], []),
      mk(6, 805, 'Filler D', [], []),
      mk(7, 806, 'Filler E', [], []),
      mk(8, 807, 'Distant Perfect Match', [2], [3]), // both, but 7 places away
    ],
  };

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
    check('the button is consumed once used',
      !body.querySelector('[data-action="trailer"]'));
  }

  // without one
  {
    const dom = makeDom(CAT, { detail: WITHOUT });
    await sleep(200);
    const body = await pickAndRecommend(dom, 'Source Show');
    await sleep(400);
    check('no button when the show has no trailer',
      !body.querySelector('[data-action="trailer"]'));
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
    !hero()?.classList.contains('hero-has-banner')
      && /--art:#1a3a8f/.test(hero()?.getAttribute('style') || ''),
    hero()?.getAttribute('style'));

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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
