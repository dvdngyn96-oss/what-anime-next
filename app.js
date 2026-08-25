/* whatanimeshouldiwatchnext
 *
 * The site runs off a local ranking catalogue (anime.json) harvested from
 * MyAnimeList's top-anime list, so search and recommendations are instant and
 * need no API at runtime. Anything outside the catalogue is fetched live from
 * AniList on demand and remembered locally, so the catalogue grows with use.
 */

/* Absolute, like every other path the page fetches. Results are prerendered
   at /anime/<id>/<slug>/ now, and a relative 'anime.json' from there resolves
   to /anime/<id>/<slug>/anime.json — a 404 that would take the whole page
   down. Nothing here is ever served from a subdirectory of its own. */
const CATALOGUE_URL = '/anime.json';
const EXTRAS_KEY = 'wanx:extras:v1';
const MAX_RESULTS = 12;      // shown in the "others" grid
/* Collected per tier, per direction. This used to be 24, which quietly capped
 * a walk at roughly 25 results even when far more matched — The Unwanted Undead
 * Adventurer has 133 shows sharing all three of its genres. The low cap was
 * also doing accidental duty keeping candidates local, but the affinity window
 * below now handles that directly, so it can be generous. */
const MAX_PER_TIER = 60;
const AFFINITY_WINDOW = 5;   // how far a *slightly* better thematic match may jump
/* Ranking positions of extra distance a candidate earns per point of affinity.
 * Measured in positions rather than bucket slots on purpose: a bucket holds
 * only genre-sharing candidates, so ten bucket slots can span 1,500 places.
 *
 * Now the *floor* of a range rather than a flat figure — see reachPerPoint.
 * 30 positions is a small step at #5 and nothing at all at #1508, which is why
 * GATE: Jieitai could never reach matches that were plainly right. */
const AFFINITY_REACH = 30;
/* How far a candidate may come forward scales with where the anchor sits, and
 * is capped.
 *
 * Both halves are load-bearing, and each was arrived at by breaking the other.
 * A flat 30 positions under-reaches deep in the catalogue: GATE's isekai and
 * military matches sit ~195 places away and could never be picked, so it
 * recommended Slayers. Measuring distance as a *ratio* instead — the obvious
 * fix, and tried first — over-reaches at the same end: Fullmetal Alchemist:
 * Brotherhood began recommending Arslan Senki (#1594) and Grancrest Senki
 * (#3559), which is the one bug this file warns about twice.
 *
 * So the unit stays positions and the budget moves. At #5 it is 30, so the top
 * of the catalogue behaves exactly as it did. At #1508 it is 60, enough for
 * Drifters. The cap is what stops a deep anchor leaping thousands of places.
 *
 * 60 is the mildest cap that works, not a preference: at 50 GATE still leads
 * with Slayers, at 60 it leads with Drifters, and every value above 60 costs
 * more anchors without gaining another. */
const REACH_FRACTION = 0.30;
const REACH_CAP = 60;
const MAX_LOOKAHEAD = 30;    // how far ahead to look at all, for cost only

/* How many times longer than what you watched a show may be before it is
 * demoted a tier. See the lengthClash comment in collectTiers. */
const LENGTH_MISMATCH = 6;
/* A show still airing this many years after it started has no episode count in
 * the catalogue and is long-running by definition, so its length is estimated
 * rather than treated as unknown. Below the threshold it stays unknown: a show
 * three episodes into its first season is airing too, and guessing there would
 * penalise every new series. */
const LONG_RUNNING_YEARS = 5;
const EPISODES_PER_YEAR = 40;    // a weekly slot, allowing for breaks

/* How rare a theme must be before it counts as a genre — a *share* of the
 * catalogue, not a count, because rarity only means anything relative to the
 * corpus it is measured in. A fixed count of 200 looked equivalent on a
 * 3,532-entry catalogue and made every theme in a six-entry test fixture
 * "rare", which is how the test suite caught it.
 *
 * At 5% of 3,532 entries the cutoff is 176 shows: Isekai (161), Military
 * (148), Harem (144), Psychological (132), Space (114), Time Travel (50) and
 * everything rarer count; Martial Arts (207), Adult Cast (255), Mecha (270),
 * Historical (403) and School (658) stay tie-breakers only. */
const SIGNATURE_THEME_SHARE = 0.05;

/* Bump alongside the ?v= markers in index.html. Shown on the page so it's
   obvious at a glance whether the browser is running the current script — a
   stale cached app.js has caused more confusion here than any real bug. */
const BUILD = 45;

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

let ranked = [];              // every anime, in MyAnimeList rank order
let byCompletion = [];        // the same anime, ordered by length-adjusted completion
let byId = new Map();
let catalogueMeta = null;
let studioNames = [];
let signatureThemes = new Set();   // themes rare enough to count as a genre

/**
 * Which country's streaming listings to show. Availability differs sharply —
 * Hulu is US-only, Amazon Prime ordering differs — so guessing wrong makes the
 * whole feature misleading. Start from the browser's locale, let it be changed,
 * and remember the choice.
 */
/* Voting. A random id in local storage and nothing else — no account, no
 * email, no way back to a person. It is enough to stop an honest visitor being
 * counted twice and stops nobody determined, which is the accepted trade and
 * the reason the figure is presented as soft rather than as survey data. */
const VOTER_KEY = 'wanx:voter:v1';
const MY_VOTES_KEY = 'wanx:myvotes:v1';
/* Below this many ratings no percentage is shown. "100% would recommend" off a
 * single vote looks like data and is not. The server sends its own floor; this
 * is the fallback for when the request never lands. */
const VOTE_FLOOR = 30;

/**
 * The tip jar — built, deliberately not launched.
 *
 * **With `TIP_JAR_URL` empty nothing renders at all**, so the page is byte for
 * byte the page it was. Launching it is pasting a URL in here and bumping the
 * build; there is no other switch, and nothing else to remember.
 *
 * It goes in the credit line, which lives only on the landing view — so it is
 * structurally impossible for it to move the card, which is the rule every
 * addition to this page is measured against. The cost of that safety is that
 * someone arriving on a shared `/?id=N` link never sees it.
 *
 * **MyAnimeList, the only credential left, permits this outright**: its API
 * agreement defines non-commercial as "personal, educational, open source or
 * communal" and allows *"donations without any quotas"*. TMDB was the awkward
 * one — it counted donations as possibly commercial — and it stopped being a
 * dependency in build 40, which is what unblocked this.
 */
const TIP_JAR_URL = '';
const TIP_JAR_LABEL = 'Buy me a coffee';

/** This browser's anonymous voter id, made once and kept. */
const voterId = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    try {
      cached = localStorage.getItem(VOTER_KEY);
      if (!cached || !/^[A-Za-z0-9_-]{16,64}$/.test(cached)) {
        cached = [...crypto.getRandomValues(new Uint8Array(18))]
          .map((n) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[n % 64])
          .join('');
        localStorage.setItem(VOTER_KEY, cached);
      }
    } catch {
      // Private browsing. Vote anyway; it just will not be remembered.
      cached = cached || 'anonymous000000000000000';
    }
    return cached;
  };
})();

/** How this browser voted, so the buttons can show it without asking the
 *  server — and so a second click on the same answer costs no request. */
let myVotes = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(MY_VOTES_KEY) || '{}'))); }
  catch { return new Map(); }
})();

function rememberVote(id, liked) {
  myVotes.set(String(id), liked);
  try { localStorage.setItem(MY_VOTES_KEY, JSON.stringify(Object.fromEntries(myVotes))); }
  catch { /* private browsing */ }
}

/* Ratings already fetched this session. Successes only — a failure is never
 * cached, the same rule as a failed synopsis fetch, so a dropped request does
 * not leave a card permanently blank. */
const ratingCache = new Map();
let ratingFloor = VOTE_FLOOR;

/**
 * Which formats may be *recommended*.
 *
 * The catalogue is 2,641 TV, 540 ONA, 309 OVA. ONA is the mixed bag: it holds
 * Cyberpunk: Edgerunners and Takopi's Original Sin alongside a long tail of
 * donghua that crowds the isekai range, so "all or nothing" is the wrong
 * control — this is per format.
 *
 * It filters candidates only. Whatever you searched for stays usable as an
 * anchor, because refusing to accept the show someone just typed would be
 * baffling.
 */
const FORMATS_KEY = 'wanx:formats';
const ALL_FORMATS = ['TV', 'ONA', 'OVA'];

let formats = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(FORMATS_KEY) || 'null');
    if (Array.isArray(saved) && saved.length && saved.every((f) => ALL_FORMATS.includes(f))) {
      return new Set(saved);
    }
  } catch { /* private browsing, or someone edited it by hand */ }
  return new Set(ALL_FORMATS);
})();

function saveFormats() {
  try {
    localStorage.setItem(FORMATS_KEY, JSON.stringify([...formats]));
  } catch { /* not worth failing over */ }
}

/**
 * Whether to recommend only shows from 2010 onwards.
 *
 * 41% of the catalogue is older than that — 1,427 entries against 2,053 from
 * 2010 on — and bouncing off older art and pacing is a real preference rather
 * than a snobbery to be corrected. So it is one chip, off by default.
 *
 * **One chip, not a row, and not a slider.** Three toggle rows already pushed
 * the card most of a screen down on a 360px phone, and the fix for that was
 * cutting reserved space from three rows to two. A fourth row would undo it.
 * This chip rides in the gap beside the direction toggle, which is 104px wide
 * at 360px and was otherwise wasted, so the toggle block stays exactly 68px
 * tall — measured, not assumed. If 2000+ or 2015+ is ever wanted, that is a
 * second chip, not a redesign.
 *
 * Same rule as the format filter: it filters candidates, never the anchor.
 * Refusing to accept an old show someone just typed would be baffling — "I
 * watched this in 1998, what next" is a perfectly good question.
 */
const MODERN_KEY = 'wanx:modern';
const MODERN_FROM = 2010;

let modernOnly = (() => {
  try {
    return localStorage.getItem(MODERN_KEY) === '1';
  } catch { /* private browsing */ }
  return false;
})();

function saveModernOnly() {
  try {
    localStorage.setItem(MODERN_KEY, modernOnly ? '1' : '0');
  } catch { /* not worth failing over */ }
}

/**
 * Shows you have already watched, so they stop being recommended.
 *
 * Same rule as the format filter: this filters candidates, never the anchor.
 * Searching something you have seen is the normal way to use this site — "I
 * watched this, what next" — so whatever you type is always accepted.
 *
 * It lives in this browser and nowhere else. There is no account and no server:
 * a MyAnimeList export is read on your own machine and never uploaded. The
 * flip side is that it does not follow you to another device, and clearing your
 * browsing data clears it. Both are the price of not holding anyone's data.
 */
const WATCHED_KEY = 'wanx:watched:v1';

let watched = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHED_KEY) || 'null');
    if (Array.isArray(saved)) return new Set(saved.filter((id) => Number.isFinite(id)));
  } catch { /* private browsing, or someone edited it by hand */ }
  return new Set();
})();

function saveWatched() {
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...watched]));
  } catch { /* not worth failing over */ }
}

/** Returns how many were genuinely new, so the import can report a real number. */
function markWatched(ids) {
  let added = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0 && !watched.has(id)) { watched.add(id); added += 1; }
  }
  if (added) saveWatched();
  return added;
}

function clearWatched() {
  watched = new Set();
  saveWatched();
}

/* How many candidates the watched list removed from the last walk. Without
   this, a walk emptied by the watched list would report "nothing shares these
   genres", which is false and would read as the matcher being broken. */
let watchedSkipped = 0;

/* And how many the "2010 or later" chip removed. Same reasoning as above, and
   the same trap: a walk emptied by a filter has to name the filter, or the
   page blames the matcher for a choice the viewer made. */
let yearSkipped = 0;

/**
 * Which ordering the walk climbs: MyAnimeList's score ranking, or how well a
 * show holds the people who start it.
 */
let axis = 'rank';            // 'rank' | 'completion'

const activeList = () => (axis === 'completion' && byCompletion.length ? byCompletion : ranked);

/**
 * Ordinal position in the rank-sorted catalogue, 1-based, mirroring
 * completionPos. Kept separate from `rank` because MyAnimeList hands the same
 * rank to different titles — 64 such collisions in the top 8,000 — and the
 * walk needs a strictly ordered axis to climb. `rank` stays MAL's number, and
 * is what the card shows.
 */
function renumberRanked(from = 0) {
  for (let i = from; i < ranked.length; i++) ranked[i].rankPos = i + 1;
}

/** Position on the active axis. Lower is better, like a rank. */
const positionOf = (anime) => (
  axis === 'completion' && byCompletion.length ? anime.completionPos : (anime.rankPos ?? null)
);

/**
 * AniList tags, unpacked from `index * 10 + weight`.
 *
 * Weight is floor(rank/10) clamped to 5..9, and only tags at 50% or better are
 * stored, so the units digit is never 0 and the pair always separates cleanly.
 * The norm is precomputed because every candidate in a walk is compared
 * against the same source, and recomputing it per comparison showed up.
 */
function unpackTags(packed) {
  if (!packed?.length) return null;
  const weights = new Map();
  let sumSquares = 0;
  for (const n of packed) {
    const w = n % 10;
    weights.set((n - w) / 10, w);
    sumSquares += w * w;
  }
  return { weights, norm: Math.sqrt(sumSquares) };
}

/**
 * Cosine similarity between two tag vectors, 0..1, or null if either side has
 * no tags.
 *
 * Cosine rather than raw overlap on purpose. Popular shows carry three or four
 * times as many tags as obscure ones — Fullmetal Alchemist: Brotherhood has 37
 * usable, a quiet 2013 OVA has 4 — so an unnormalised sum would rank by fame,
 * which is the same failure the affinity window already exists to prevent.
 */
function tagSimilarity(a, b) {
  if (!a?.tags || !b?.tags) return null;
  const [small, large] = a.tags.weights.size <= b.tags.weights.size
    ? [a.tags, b.tags]
    : [b.tags, a.tags];

  let dot = 0;
  for (const [idx, weight] of small.weights) {
    const other = large.weights.get(idx);
    if (other) dot += weight * other;
  }
  return dot / (a.tags.norm * b.tags.norm);
}

/* Themes rare enough to identify a show rather than merely describe it.
 *
 * MyAnimeList files the useful word as a *theme*, and themes only broke ties,
 * so "shares Fantasy" (968 shows) decided matching while "shares Isekai" (161)
 * did not. Konosuba is the case that made this worth fixing: exactly one thing
 * above it shared all three of its genres, 163 places away, and serving that
 * single distant match dragged the walk's high-water mark to the top of the
 * rankings — after which monotonicity deferred every nearer isekai, including
 * one 24 places away. Not one isekai in its first seven results.
 *
 * The cutoff is a frequency, not a hand-written list, because the whole point
 * is rarity: a theme that half the catalogue carries tells you nothing, and
 * which themes are rare is a property of the data that a rebuild can change.
 * Counted here rather than baked in so it cannot go stale.
 */
function markSignatureThemes() {
  const freq = new Map();
  for (const anime of ranked) {
    for (const theme of anime.themes || []) freq.set(theme, (freq.get(theme) || 0) + 1);
  }
  const cutoff = ranked.length * SIGNATURE_THEME_SHARE;
  signatureThemes = new Set(
    [...freq].filter(([, count]) => count <= cutoff).map(([theme]) => theme)
  );
}

/** Compact catalogue rows -> the shape the rest of the app works with. */
function expand(row, names) {
  return {
    id: row.i,
    rank: row.r,
    title: row.t,
    titleEnglish: row.en || '',
    score: row.s,
    status: row.st || null,
    type: row.ty,
    episodes: row.e,
    year: row.y,
    members: row.m,
    image: row.im ? `https://cdn.myanimelist.net/images/anime/${row.im}` : '',
    colour: row.cl ? `#${row.cl}` : null,
    banner: row.bn ? `https://s4.anilist.co/file/anilistcdn/media/anime/banner/${row.bn}` : null,
    genres: (row.g || []).map((i) => names[i]).filter(Boolean),
    themes: (row.th || []).map((i) => names[i]).filter(Boolean),
    demographic: (row.d || []).map((i) => names[i]).filter(Boolean)[0] || null,
    stats: row.stats || null,
    tags: unpackTags(row.tg),
    studios: (row.su || []).map((i) => studioNames[i]).filter(Boolean),
    url: `https://myanimelist.net/anime/${row.i}`,
    local: true,
  };
}

function loadExtras() {
  try {
    return JSON.parse(localStorage.getItem(EXTRAS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveExtra(entry) {
  try {
    const extras = loadExtras().filter((e) => e.id !== entry.id);
    extras.push(entry);
    localStorage.setItem(EXTRAS_KEY, JSON.stringify(extras));
  } catch { /* private browsing, quota — not worth failing over */ }
}

/**
 * Flag well-regarded shows that comparatively few people have watched.
 *
 * Thresholds come from the catalogue's own distribution rather than fixed
 * numbers, so this keeps working as the rankings shift between rebuilds.
 * An 8.2 with 40k members is a find; an 8.2 with 2M members is just famous.
 */
function markHiddenGems() {
  const quantile = (values, q) => {
    const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0;
  };

  const memberCut = quantile(ranked.map((a) => a.members), 0.4);
  const scoreCut = quantile(ranked.map((a) => a.score), 0.6);

  for (const anime of ranked) {
    anime.gem = anime.members != null && anime.score != null
      && anime.members <= memberCut && anime.score >= scoreCut;
  }
}

/** Slot an entry into the ranking by score, so live finds share one axis with the catalogue. */
function insertByScore(entry) {
  if (byId.has(entry.id)) return byId.get(entry.id);
  const at = ranked.findIndex((a) => (a.score ?? 0) < (entry.score ?? 0));
  const index = at === -1 ? ranked.length : at;
  ranked.splice(index, 0, entry);
  renumberRanked(index);          // everything below the insert shifts down one
  byId.set(entry.id, entry);
  if (!entry.local) saveExtra(entry);   // remember it for next visit
  return entry;
}

let cataloguePromise = null;

function loadCatalogue() {
  if (cataloguePromise) return cataloguePromise;

  cataloguePromise = (async () => {
    // Always revalidate. Rebuilding the catalogue replaces this file in place,
    // and a browser holding a stale copy would quietly serve the old rankings
    // (and old filtering rules). A 304 keeps this cheap when nothing changed.
    const res = await fetch(CATALOGUE_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load the catalogue (HTTP ${res.status}).`);
    const data = await res.json();

    catalogueMeta = { built: data.built, count: data.count, scanned: data.scanned };
    studioNames = data.studios || [];
    ranked = data.anime.map((row) => expand(row, data.names));
    renumberRanked();
    byId = new Map(ranked.map((a) => [a.id, a]));
    markSignatureThemes();
    markHiddenGems();
    fitCompletionCurve();
    buildCompletionOrder();

    for (const extra of loadExtras()) insertByScore(extra);
    return ranked;
  })();

  // A failed load is never remembered. Everything on the page waits on this one
  // promise — search, the dice, a shared link — so caching the rejection turns a
  // single dropped request into a session that stays broken until a reload.
  // Same reasoning as never caching a failed synopsis fetch, one level up where
  // it costs the whole page rather than five lines of it.
  //
  // The notice rides along here rather than at each call site because it
  // reflects the state of the catalogue, and this is the only place that knows.
  cataloguePromise.then(
    () => setCatalogueNotice(null),
    (error) => { cataloguePromise = null; setCatalogueNotice(error); },
  );

  return cataloguePromise;
}

/** Human wording for a catalogue that would not load. */
function catalogueTrouble(error) {
  const detail = String(error?.message ?? error);
  const status = detail.match(/HTTP (\d{3})/);
  if (status) return `The catalogue could not be loaded — the server returned ${status[1]}.`;
  // A Pages deploy mid-flight serves index.html for anime.json, which arrives
  // here as a parse error rather than as a bad status.
  if (/JSON|Unexpected token/i.test(detail)) {
    return 'The catalogue came back damaged. A deploy may be in progress — this usually clears in a minute.';
  }
  // Everything else, "Failed to fetch" included, is jargon to someone who just
  // wanted a recommendation.
  return 'The catalogue could not be loaded. Check your connection and try again.';
}

/** The landing page cannot say "no results" when it never had any to search. */
function setCatalogueNotice(error) {
  const notice = document.getElementById('catalogue-notice');
  if (!notice) return;
  notice.textContent = error ? catalogueTrouble(error) : '';
  notice.hidden = !error;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const normalise = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Lower is better; null means no match. Checks both the romaji and English title. */
function matchTier(anime, q, tight, wordRe) {
  let best = null;
  for (const raw of [anime.title, anime.titleEnglish]) {
    if (!raw) continue;
    const title = normalise(raw);
    if (!title) continue;

    let tier;
    if (title === q) tier = 0;
    else if (title.startsWith(q)) tier = 1;
    else if (wordRe.test(title)) tier = 2;
    else if (squash(raw).includes(tight)) tier = 3;
    else continue;

    if (best === null || tier < best) best = tier;
  }
  return best;
}

function searchLocal(query, limit = 8) {
  const q = normalise(query);
  if (!q) return [];
  const tight = squash(query);
  const wordRe = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

  const scored = [];
  for (const anime of ranked) {
    const tier = matchTier(anime, q, tight, wordRe);
    if (tier === null) continue;
    scored.push({ anime, tier });
    if (scored.length > 600) break;
  }

  scored.sort((a, b) => a.tier - b.tier || (b.anime.members ?? 0) - (a.anime.members ?? 0));
  return scored.slice(0, limit).map((s) => s.anime);
}

/* ------------------------------------------------------------------ *
 * Live expansion (AniList) — for anything outside the catalogue
 * ------------------------------------------------------------------ */

const ANILIST = 'https://graphql.anilist.co';

async function anilist(query, variables) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList responded ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const SEARCH_QUERY = `query ($s: String) {
  Page(page: 1, perPage: 6) {
    media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
      idMal title { romaji english } averageScore popularity genres
      episodes seasonYear format coverImage { large } description(asHtml: false)
    }
  }
}`;

const DETAIL_QUERY = `query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    description(asHtml: false)
    trailer { id site }
    externalLinks { site url type }
  }
}`;

/* How many services fit on the row. It is a single reserved line, and popular
 * titles carry six or more — Frieren has Crunchyroll, Bilibili, YouTube,
 * Netflix, Hulu and Prime Video — so past four they would be clipped
 * mid-chip. Kept in AniList's own order rather than re-sorted to a favourite
 * list, which would be editorialising on no evidence. */
const MAX_SERVICES = 4;

function fromAniList(media) {
  return {
    id: media.idMal,
    rank: null,
    title: media.title.romaji || media.title.english,
    titleEnglish: media.title.english || '',
    themes: [],
    score: media.averageScore ? Number((media.averageScore / 10).toFixed(2)) : null,
    type: media.format,
    episodes: media.episodes,
    year: media.seasonYear,
    members: media.popularity,
    image: media.coverImage?.large || '',
    genres: media.genres || [],
    url: media.idMal ? `https://myanimelist.net/anime/${media.idMal}` : '',
    synopsis: (media.description || '').replace(/<[^>]+>/g, '').trim(),
    local: false,
  };
}

async function searchLive(query) {
  const data = await anilist(SEARCH_QUERY, { s: query });
  return (data.Page.media || [])
    .filter((m) => m.idMal && m.genres?.length)
    .map(fromAniList);
}

const detailCache = new Map();

/**
 * Synopsis and trailer in one request — the catalogue carries neither, and
 * they come back on the same AniList query, so a trailer costs nothing extra.
 */
async function fetchDetails(anime) {
  if (detailCache.has(anime.id)) return detailCache.get(anime.id);

  try {
    const data = await anilist(DETAIL_QUERY, { idMal: anime.id });
    const raw = data.Media?.trailer;
    /* Where to watch, from the same request that fetches the synopsis — so
       the listings cost nothing extra and are current, rather than being
       baked into the catalogue and going stale between rebuilds. Deduped by
       service, because a title can carry both "Bilibili" and "Bilibili TV". */
    const seen = new Set();
    const streams = (data.Media?.externalLinks || [])
      .filter((l) => l.type === 'STREAMING' && l.site && l.url)
      .filter((l) => !seen.has(l.site) && seen.add(l.site));
    const details = {
      synopsis: (data.Media?.description || '').replace(/<[^>]+>/g, '').trim(),
      // Only these two embed cleanly; anything else is treated as absent.
      trailer: raw?.id && ['youtube', 'dailymotion'].includes(raw.site)
        ? { id: raw.id, site: raw.site }
        : null,
      streams,
    };
    detailCache.set(anime.id, details);
    return details;
  } catch {
    /* Deliberately *not* cached.
     *
     * AniList rate-limits, and clicking "show me another" quickly fires one
     * request per card, so a burst produces failures. Caching those stored
     * "no synopsis" permanently for the session — and since the card now
     * reserves five lines for it, that showed as a hole rather than as
     * nothing. Leaving it uncached means the next visit tries again. */
    return { synopsis: '', trailer: undefined, streams: undefined, failed: true };
  }
}

/** Privacy-preserving embed, only built once someone asks to watch. */
function trailerEmbed(trailer) {
  const src = trailer.site === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.id)}?autoplay=1&rel=0`
    : `https://www.dailymotion.com/embed/video/${encodeURIComponent(trailer.id)}?autoplay=1`;

  return `<iframe class="hero-trailer" src="${esc(src)}" title="Trailer"
    allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

/* ------------------------------------------------------------------ *
 * The ranking walk
 * ------------------------------------------------------------------ */

/**
 * How long a show is, in episodes, or null when that genuinely cannot be said.
 *
 * 38 entries have no episode count and every one of them is currently airing —
 * which covers both One Piece and Meitantei Conan, the two longest things in
 * the catalogue, and a brand-new series three episodes in. Treating the whole
 * group as unknown made the length rule incoherent the moment it shipped:
 * walking up from Overlord it demoted Dragon Ball at 153 episodes and One
 * Piece, at more than a thousand, walked straight into the slot it vacated.
 *
 * So a show still airing LONG_RUNNING_YEARS after it began gets an estimate
 * from its own run length, which is not a guess in any meaningful sense — a
 * weekly series broadcasting since 1999 has over a thousand episodes whatever
 * the catalogue says. Anything airing for less stays unknown, because there
 * the ambiguity is real.
 */
function lengthOf(anime) {
  if (anime.episodes) return anime.episodes;
  if (anime.status !== 'air' || !anime.year) return null;
  const years = new Date().getFullYear() - anime.year;
  return years >= LONG_RUNNING_YEARS ? years * EPISODES_PER_YEAR : null;
}

function sameFranchise(a, b) {
  const x = squash(a.title);
  const y = squash(b.title);
  if (x.length < 4 || y.length < 4) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Step away from `source` through the ranking, one position at a time, and
 * collect entries that share its genres.
 *
 * direction 'up'   -> toward rank #1 (better than what you watched)
 * direction 'down' -> toward the bottom of the list
 */
/**
 * A shared *rare* theme is worth one genre — but never a longer jump than the
 * tier it is joining already makes.
 *
 * Why it is needed at all: affinity could already reorder a bucket, but it
 * could never pull a strong theme match *into* one, and reordering was not the
 * problem. Which candidates survive a pass is decided by the high-water mark,
 * not by their order within it. Konosuba's nearest isekai is 24 places away
 * and shares two of its three genres; every ordering of the 2-of-3 bucket
 * still leaves it behind a frontier already dragged to position 34 by the
 * single, distant 3-of-3 match. It has to enter the *top* bucket to be
 * reachable at all.
 *
 * Why it is bounded by distance: the first version was not, and it re-created
 * the Arslan Senki bug this file warns about twice. Berserk has five genres,
 * so exactly one entry shares them all — and unbounded promotion let Arslan
 * Senki (528 places away) and Grancrest Senki (1,376) into that tier. The walk
 * took those first, raced the frontier to the far end of the rankings, and
 * monotonicity then deleted the dense tier of near neighbours below. Same
 * shape as the original bug, caused by the fix for it.
 *
 * So a candidate may only join the tier above if it is no further from the
 * source than that tier's nearest existing member. Promotion can densify a
 * sparse tier with nearer entries; it can never make one reach further. That
 * also means the rule fires only where the problem is — when the top tier is
 * sparse and distant — and is a no-op when it is already dense and close.
 *
 * An empty tier is never created. With nothing there to measure against there
 * is no reach to respect, and a lone promoted entry ahead of a dense tier is
 * exactly the failure above.
 */
function promoteSignatures(buckets, distanceOf, total) {
  // Measured before anything moves, so a promoted entry can never extend the
  // reach that the next promotion is checked against.
  const nearest = buckets.map(
    (bucket) => bucket.reduce((min, a) => Math.min(min, distanceOf(a)), Infinity)
  );

  // High tiers first: a destination is always processed before the tier that
  // feeds it, so nothing can be promoted twice.
  for (let tier = total - 1; tier >= 1; tier--) {
    const destination = buckets[tier + 1];
    if (!destination?.length) continue;

    const reach = nearest[tier + 1];
    const moving = buckets[tier].filter(
      (a) => a.signatureThemes?.length && distanceOf(a) <= reach
    );
    if (!moving.length) continue;

    const moved = new Set(moving);
    for (const a of moving) a.promoted = true;
    buckets[tier] = buckets[tier].filter((a) => !moved.has(a));
    // preferLocally reads the head of a bucket as the nearest candidate, so the
    // tier has to come back out in proximity order.
    buckets[tier + 1] = destination.concat(moving).sort((a, b) => distanceOf(a) - distanceOf(b));
  }
}

/**
 * Bucket nearby anime by how many of the source's genres they share.
 * Returns an array indexed by shared count: buckets[3] shares all three, etc.
 */
function collectTiers(source, direction, exclude) {
  const total = source.genres.length;
  const buckets = Array.from({ length: total + 1 }, () => []);
  const list = activeList();
  const start = list.indexOf(source);
  if (start === -1) return buckets;

  const want = new Set(source.genres);
  const wantThemes = new Set(source.themes || []);
  const wantDemographic = source.demographic;
  const step = direction === 'up' ? -1 : 1;

  for (let i = start + step; i >= 0 && i < list.length; i += step) {
    const candidate = list[i];

    // The catalogue is TV first seasons only. Entries pulled in live are
    // whatever the user searched — fine as a starting point, but they haven't
    // been checked for being a film or a sequel, so never recommend them.
    if (!candidate.local) continue;
    // Belt and braces: the catalogue only holds standalone TV/OVA/ONA, but a
    // live-fetched entry could be anything.
    if (candidate.type && !ALL_FORMATS.includes(candidate.type)) continue;
    // The viewer's format filter. Entries with no type recorded are kept —
    // that is a data gap, not a format they chose to exclude.
    if (candidate.type && !formats.has(candidate.type)) continue;
    if (exclude.has(candidate.id)) continue;                   // already seen this chain
    if (sameFranchise(candidate, source)) continue;

    const shared = candidate.genres.filter((g) => want.has(g)).length;

    /* 31 entries have no genres at all — MyAnimeList's data thins out for
     * pre-1990 TV and merchandise-driven shows, and the AniList backfill could
     * not help because their only AniList genre is one of the four that are
     * MAL *themes*. With no genres they can never share one, so the walk could
     * never reach them: invisible rather than unlikely.
     *
     * They can still match on themes. That signal is weaker than a genre, so
     * they go to bucket 0, below every genre match, and surface only once real
     * matches are exhausted. Scoped to entries with *no* genres: something
     * that has genres and simply shares none of yours is a miss, not a
     * fallback, and giving it a second route would change matching for the
     * whole catalogue. */
    const themeOnly = !candidate.genres.length;
    if (!shared && !themeOnly) continue;
    // A genre-less entry is only really a match if it shares a theme; that is
    // the sole basis on which it reaches buckets[0] below. Deciding it here
    // rather than there changes nothing about what gets recommended — it just
    // lets the two counters underneath be exact.
    if (themeOnly && !(candidate.themes || []).some((t) => wantThemes.has(t))) continue;

    /* The two filters the viewer controls are applied *here*, after the match
       test, and counted.
     *
     * They used to be applied further up, beside the format filter, which
     * made both counters wrong in the same way: they counted every entry the
     * scan walked past rather than every entry that would otherwise have been
     * recommended. collectTiers walks the whole catalogue in each direction,
     * so the number the note reported was really the size of the filter.
     * Marking 40 sports shows watched made Cowboy Bebop — Action, Award
     * Winning, Sci-Fi — report "40 shows that matched", when it shares a genre
     * with none of them and the true answer is none. The year chip showed the
     * same bug far more loudly: 1,426, which is the whole pre-2010 catalogue.
     *
     * The format filter above is deliberately *not* moved. It is uncounted and
     * unreported, so where it sits cannot mislead anyone, and leaving it early
     * keeps the scan cheap. */
    // Shows you have marked as watched. Counted rather than silently skipped,
    // so an emptied walk can say why it is empty.
    if (watched.has(candidate.id)) { watchedSkipped += 1; continue; }
    /* The viewer's "2010 or later" chip. The 13 entries with no year on record
       are kept, for the same reason as a missing type: that is a gap in the
       data, not an era anyone chose to exclude. */
    if (modernOnly && candidate.year && candidate.year < MODERN_FROM) { yearSkipped += 1; continue; }

    // Themes (School, Urban Fantasy, Isekai…) don't decide whether something
    // matches, but among equals they're the difference between "same genres"
    // and "same kind of show". Demographic counts for more — Shounen vs Josei
    // is a wider gap than School vs Adult Cast — but only when both sides
    // declare one. Only 41% do, so a missing demographic is never a penalty.
    candidate.sharedThemes = (candidate.themes || []).filter((t) => wantThemes.has(t));
    candidate.sharedDemographic = Boolean(
      wantDemographic && candidate.demographic === wantDemographic
    );

    /* AniList's weighted tags are a far better similarity signal than MAL's
     * handful of flat themes — "Alchemy 90%, Military 90%, War 90%" against
     * plain "Military" — so when both sides have them, cosine similarity
     * replaces the theme count.
     *
     * **Rounded, and that rounding is load-bearing.** Under the old signal
     * most candidates shared no themes at all, so affinity was 0 for nearly
     * everyone and preferLocally was almost a no-op — proximity survived by
     * stable sort. A continuous score gives every candidate a distinct value,
     * so every window reorders, and the walk's monotonicity rule turns each
     * reorder into a deferral: put a distant match first and the nearer ones
     * stop "advancing" and get held. Unrounded, that cost Steins;Gate its
     * documented chain to Evangelion, Shinsekai yori and Serial Experiments
     * Lain in one go. Rounding restores the ties, and with them proximity.
     *
     * Scaled by 6 because similarity runs about 0.1-0.6 in practice, which
     * lands on 1-4 — the range the theme count occupied, and what the
     * affinity window and the demographic bonus of 2 were tuned against.
     *
     * 8% of entries have no usable tags; those fall back to themes. The two
     * scales are close enough that a fallback candidate isn't systematically
     * advantaged inside the window. */
    const similarity = tagSimilarity(source, candidate);
    candidate.tagSimilarity = similarity;
    candidate.affinity = (similarity == null ? candidate.sharedThemes.length : Math.round(similarity * 6))
      + (candidate.sharedDemographic ? 2 : 0);

    /* Kids is the one demographic that marks a different audience rather than
     * a different tone — Shounen, Seinen, Shoujo and Josei all sit on a
     * spectrum, children's programming does not. Without this, The Unwanted
     * Undead Adventurer (a 12-episode dark isekai) recommends Pokémon: 276
     * episodes, same three genres, 48 places away, so proximity hands it the
     * top spot. It affects 54 anchors. Demoted a tier rather than excluded,
     * so it can still surface once closer matches run out. */
    // A genre-less entry earns its place only if a theme actually matches.
    if (themeOnly) {
      if (candidate.sharedThemes.length) buckets[0].push(candidate);
      continue;
    }

    /* A shared *rare* theme is worth one genre, and one only.
     *
     * Affinity could already reorder a bucket, but it could never pull a
     * strong theme match *into* one, and reordering was not the problem:
     * which candidates survive a pass is decided by the high-water mark, not
     * by their order within it. Konosuba's nearest isekai sits 24 places away
     * and shares two of its three genres; every ordering of the 2-of-3 bucket
     * leaves it behind a frontier already dragged to position 34 by the single
     * 3-of-3 match. It has to enter the *top* bucket to be reachable at all.
     *
     * Bounded on every side, because changing what decides matching is the
     * riskiest edit here:
     *   - it only ever promotes, so nothing gets a worse tier than before
     *   - it needs at least one genre already shared, so it invents no new
     *     matches and leaves the genre-less tier in buckets[0] alone
     *   - one tier, never two, and never above a full match
     * The true genre count is kept for the note, which must not claim a
     * shared genre that is really a shared theme.
     */
    candidate.signatureThemes = candidate.sharedThemes.filter((t) => signatureThemes.has(t));
    candidate.matchGenres = shared;
    // Cleared on every scan: these are catalogue objects, reused across walks,
    // and a stale flag would have the note explain a promotion that this walk
    // never made.
    candidate.promoted = false;

    /* A very long series against a very short one, demoted the same way and
     * for the same reason as Kids.
     *
     * The matcher never looked at length at all. GATE: Jieitai is 12 episodes
     * and its fifth result was Naruto at 220 — which shares all three of its
     * genres and sits 283 places up, four behind Juuni Kokuki, so it arrived in
     * perfectly correct order. Nothing was misbehaving; the code simply had no
     * idea it was asking for a 220-episode commitment.
     *
     * This is the case the Kids demotion already half-fixed. Pokémon gets
     * caught against a 12-episode isekai for being *Kids*; Naruto is Shounen,
     * so nothing caught it, and GATE has no demographic recorded so that
     * tie-breaker could not fire either.
     *
     * **A ratio, never an episode count**, because sometimes a long series is
     * exactly right. Measured over every pair actually served across the 19
     * known anchors, the legitimate ones top out at 5.8x — Haikyuu!! to Slam
     * Dunk is 4.0x, to Hajime no Ippo 3.0x, Steins;Gate to Monster 3.1x,
     * Mushoku Tensei to Fullmetal Alchemist: Brotherhood 5.8x — and the
     * questionable ones start at 7x: InuYasha 7.0x, Chi's Sweet Home 8.7x,
     * Dragon Ball 11.8x, Hunter x Hunter 14.8x, Naruto 18.3x. A clean gap,
     * which is more than could be said for anything separating the cases that
     * defeated the affinity work.
     *
     * **A missing episode count is estimated, not ignored** — see lengthOf.
     * Ignoring it was tried and it broke the rule immediately: Overlord
     * demoted Dragon Ball at 153 episodes and One Piece, at more than a
     * thousand, took the slot, because One Piece is still airing and so has no
     * count at all. A show airing for five years or more is long whatever the
     * data says; one airing for less is genuinely unknown and gets no
     * penalty, the same rule as a missing demographic.
     *
     * Episode count also overstates the length of shorts — Chi's Sweet Home is
     * 104 episodes of about three minutes. There is no duration in the
     * catalogue to correct with.
     *
     * One tier, not two: an entry that is both Kids and far too long is
     * demoted once, like everything else here. */
    const candidateLength = lengthOf(candidate);
    const lengthClash = Boolean(
      source.episodes && candidateLength
      && candidateLength >= source.episodes * LENGTH_MISMATCH
    );
    candidate.matchLengthClash = lengthClash;

    const audienceClash = candidate.demographic === 'Kids' && source.demographic !== 'Kids';
    buckets[audienceClash || lengthClash ? Math.max(1, shared - 1) : shared].push(candidate);

    if (buckets[total].length >= MAX_PER_TIER) break;
  }

  /* Prefer a better thematic match, but only over nearby candidates.
   *
   * Sorting a whole bucket by affinity lets a distant match leapfrog the
   * entire list: walking down from Fullmetal Alchemist: Brotherhood, Arslan
   * Senki (1,592 places away, sharing Military *and* Shounen) would jump ahead
   * of Berserk 105 places away. The premise is "the next one along", so
   * proximity leads and affinity only reorders within a short window of it.
   */
  /* The jump a candidate may make scales with how much better it is.
   *
   * A fixed window of 5 treats "one point better" and "four points better"
   * alike, and being chunk-aligned it also refuses jumps across a boundary —
   * position 5 could never overtake position 4 however good it was. This walks
   * the bucket instead, and at each step lets a candidate come forward by
   * AFFINITY_WINDOW positions per point of affinity it beats the nearest
   * candidate by, capped at MAX_LOOKAHEAD.
   *
   * The cap is the whole safety argument. Sorting a bucket outright once let
   * Arslan Senki, 1,592 places from Fullmetal Alchemist: Brotherhood, leapfrog
   * Berserk at 105 — a candidate that far away sits well beyond any lookahead
   * and can no longer do that. The premise is still "the next one along". */
  const sourcePosition = positionOf(source) ?? 0;
  const distanceOf = (a) => Math.abs((positionOf(a) ?? sourcePosition) - sourcePosition);

  promoteSignatures(buckets, distanceOf, total);

  // Between AFFINITY_REACH and REACH_CAP, proportional to where the anchor
  // sits. A show at #5 gets the old flat 30; one at #1508 gets 60.
  const reachPerPoint = Math.max(
    AFFINITY_REACH, Math.min(REACH_CAP, REACH_FRACTION * sourcePosition)
  );

  const preferLocally = (bucket) => {
    const remaining = bucket.slice();
    const out = [];

    while (remaining.length) {
      const nearest = remaining[0];
      const nearestDistance = distanceOf(nearest);
      let pick = 0;
      let bestAffinity = nearest.affinity;
      const limit = Math.min(remaining.length, MAX_LOOKAHEAD);

      for (let i = 1; i < limit; i++) {
        const candidate = remaining[i];
        if (candidate.affinity <= bestAffinity) continue;

        // A better match may sit further away, in proportion to how much
        // better it is — but measured in ranking positions, so it can never
        // come from the far end of the list.
        const earned = reachPerPoint * (candidate.affinity - nearest.affinity);
        if (distanceOf(candidate) - nearestDistance <= earned) {
          pick = i;
          bestAffinity = candidate.affinity;
        }
      }

      out.push(...remaining.splice(pick, 1));
    }
    return out;
  };

  return buckets.map((bucket) => preferLocally(bucket).slice(0, MAX_PER_TIER));
}

/**
 * Pick the best available match, preferring genre quality over direction.
 *
 * A show near the top of the rankings often has nothing above it sharing its
 * genres, but plenty just below. Serving a weak 1-of-3 match upward is worse
 * than a full match downward — Steins;Gate (#5) would otherwise recommend
 * Fullmetal Alchemist on the strength of "Drama" alone, while Evangelion sits
 * a little lower sharing all three.
 */
/**
 * Build the recommendation list, in preference order.
 *
 * Direction is kept as long as the match is still meaningful: rather than
 * turning around the moment nothing shares every genre, it drops one genre at
 * a time and keeps climbing — 3 of 3, then 2 of 3, and so on. Only once the
 * match would fall below half the genres is walking the other way preferable
 * to a recommendation that barely resembles what you watched.
 */
function walkRankings(source, direction, exclude = new Set()) {
  watchedSkipped = 0;
  yearSkipped = 0;
  const otherDirection = direction === 'up' ? 'down' : 'up';
  const total = source.genres.length;
  const primary = collectTiers(source, direction, exclude);
  const secondary = collectTiers(source, otherDirection, exclude);

  // Keep going the requested way while sharing at least half the genres.
  const floor = Math.max(1, Math.ceil(total / 2));

  const order = [];
  const run = (buckets, flipped, from, to) => {
    for (let shared = from; shared >= to; shared--) {
      order.push([shared, flipped, buckets[shared] ?? []]);
    }
  };

  run(primary, null, total, floor);
  run(secondary, otherDirection, total, floor);
  run(primary, null, floor - 1, 1);
  run(secondary, otherDirection, floor - 1, 1);
  // Bucket 0 is the theme-only tier: entries MyAnimeList gave no genres at
  // all, matched on a shared theme instead. Dead last, after every genre
  // match in both directions has been offered.
  run(primary, null, 0, 0);
  run(secondary, otherDirection, 0, 0);

  /* Three things compete, and they rank in this order:
   *
   *   1. match quality — a full genre match below beats a weak one above,
   *      which is why Steins;Gate reaches Evangelion rather than Fullmetal
   *      Alchemist on the strength of "Drama" alone
   *   2. the direction you asked for — within one quality tier, exhaust
   *      everything higher before turning around
   *   3. monotonicity — climb steadily, and defer anything out of order
   *
   * `order` already encodes 1 and 2 as a sequence of passes, so the climb and
   * its leftovers are kept per pass: each pass emits its clean run, then the
   * entries it had to defer, before the next pass begins. Pooling the
   * leftovers globally instead buried 9 upward matches behind 120 downward
   * ones; grouping by heading instead broke rule 1. */
  const passes = order.map(() => ({ heading: null, climb: [], held: [] }));
  const seen = new Set();
  const from = positionOf(source) ?? null;
  const frontiers = { up: from, down: from };

  order.forEach(([shared, flipped, group], pass) => {
    const heading = flipped || direction;
    passes[pass].heading = heading;

    for (const anime of group) {
      if (seen.has(anime.id)) continue;
      seen.add(anime.id);
      /* The tier an entry sat in and the genres it actually shares are no
         longer the same number — a rare shared theme is worth a tier. The note
         gets the truth, or it would tell someone a show shares three genres
         when it shares two and an Isekai tag. */
      anime.matchShared = anime.matchGenres ?? shared;
      anime.matchTotal = total;
      anime.matchThemes = anime.sharedThemes.length;
      anime.matchSignature = anime.promoted ? (anime.signatureThemes || []) : [];
      anime.matchDemographic = anime.sharedDemographic;
      anime.matchFlipped = flipped;
      anime.matchBacktrack = false;

      const position = positionOf(anime);
      const frontier = frontiers[heading];

      if (frontier == null || position == null) { passes[pass].climb.push(anime); continue; }

      const advances = heading === 'up' ? position < frontier : position > frontier;
      if (advances) {
        passes[pass].climb.push(anime);
        frontiers[heading] = position;
      } else {
        anime.matchBacktrack = true;
        passes[pass].held.push(anime);
      }
    }
  });

  /* Leftovers within a pass are grouped by how they were collected, which
   * would re-create the sawtooth in miniature. Sweep each into one continuous
   * run: a single step back, then a steady climb again. */
  const sweep = (items, heading) => items.sort((a, b) => {
    const pa = positionOf(a) ?? 0;
    const pb = positionOf(b) ?? 0;
    return heading === 'up' ? pb - pa : pa - pb;
  });

  const list = passes.flatMap((p) => [...p.climb, ...sweep(p.held, p.heading)]);

  /* Each loosening used to restart from the source, so the rank jumped
   * backwards and offered something worse-ranked *and* a weaker match than
   * what came before. Instead, carry the high-water mark across loosenings:
   * once the walk has reached #3771, later passes resume from there.
   *
   * Anything that would have meant stepping back is held aside rather than
   * discarded, and appended once the climb is genuinely exhausted — so the
   * list stays long, but every backwards step happens once, at the end. */

  // Everything nearby has already been dismissed — rather than dead-end,
  // forget the history and allow repeats.
  if (!list.length && exclude.size) return walkRankings(source, direction, new Set());

  return { list, flipped: list[0]?.matchFlipped ?? null };
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const searchView = $('search-view');
const resultView = $('result-view');
const resultBody = $('result-body');
const searchInput = $('search-input');
const clearBtn = $('clear-btn');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function metaLine(anime) {
  return [anime.type, anime.year, anime.score ? `★ ${anime.score}` : null]
    .filter(Boolean)
    .join(' · ');
}

function rankLabel(anime) {
  return anime.rank ? `#${anime.rank}` : 'not in the ranking';
}

/** Below this many viewers the percentage is noise, so it isn't shown. */
const MIN_STARTED = 1000;

/**
 * Longer shows are finished less often — about 7 points from a one-cour series
 * to a hundred-episode one. Comparing raw completion across lengths therefore
 * buries long shows for being long.
 *
 * So fit completion against log(episodes) across the catalogue, and measure
 * each show against what's typical for its length. Length explains only ~30% of
 * the variation, so most of the signal survives: Gintama (201 eps, 65%) stays
 * below par because 65% is poor even for its length, while Hunter x Hunter
 * (148 eps, 91%) rises, because that is genuinely exceptional for the commitment.
 */
let lengthCurve = null;

function fitCompletionCurve() {
  const points = [];
  for (const anime of ranked) {
    const s = anime.stats;
    if (!s || anime.status !== 'fin' || !anime.episodes) continue;
    const started = s.c + s.d + s.h;
    if (started < MIN_STARTED) continue;
    points.push([Math.log(anime.episodes), (s.c / started) * 100]);
  }

  if (points.length < 50) { lengthCurve = null; return; }

  const n = points.length;
  const meanX = points.reduce((t, p) => t + p[0], 0) / n;
  const meanY = points.reduce((t, p) => t + p[1], 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }

  const slope = variance ? covariance / variance : 0;
  lengthCurve = { slope, intercept: meanY - slope * meanX, n };
}

/** What completion is typical for a show of this length? */
function expectedCompletion(episodes) {
  if (!lengthCurve || !episodes) return null;
  const value = lengthCurve.intercept + lengthCurve.slope * Math.log(episodes);
  return Math.max(0, Math.min(100, value));
}

/**
 * Share of people who started it and saw it through.
 *
 * Null while a show is still airing: nobody can have completed an ongoing
 * series, so everyone sits in "watching" and the raw figure reads 0% — which
 * would rank One Piece as the worst anime in the catalogue.
 *
 * Longer shows score lower here, and that is left uncorrected: 367 episodes
 * really is a bigger commitment than 28. Episode count is shown alongside so
 * the number reads in context.
 */
function completion(anime) {
  const s = anime.stats;
  if (!s || anime.status !== 'fin') return null;

  const started = s.c + s.d + s.h;
  if (started < MIN_STARTED) return null;

  const finished = (s.c / started) * 100;
  const expected = expectedCompletion(anime.episodes);

  return {
    finished: Math.round(finished),
    dropped: Math.round((s.d / started) * 100),
    started,
    expected: expected === null ? null : Math.round(expected),
    // Positive means it holds people better than its length would predict.
    residual: expected === null ? null : Math.round(finished - expected),
  };
}

/**
 * Order the catalogue by how well each show holds its audience, corrected for
 * length. Only shows with a usable figure appear — an airing series or one with
 * a handful of viewers has no position on this axis, so it can still be a
 * starting point but is never offered as a recommendation here.
 */
function buildCompletionOrder() {
  byCompletion = ranked
    .map((anime) => ({ anime, rate: completion(anime) }))
    .filter(({ rate }) => rate)
    // Ordered on the raw figure, not the length-adjusted one. The residual is
    // the fairer way to *judge* a single show — it's how Hunter x Hunter earns
    // credit for holding people across 148 episodes — but it's a poor way to
    // *rank* them: par sits so low at the long end that any long-running show
    // with a devoted following floats to the top, and the list fills with
    // franchise serials rather than things worth recommending.
    .sort((a, b) => b.rate.finished - a.rate.finished)
    .map(({ anime }, i) => {
      anime.completionPos = i + 1;
      return anime;
    });

  for (const anime of ranked) {
    if (!Object.hasOwn(anime, 'completionPos')) anime.completionPos = null;
  }
}

/** Inline custom properties so the card takes on the show's own key art. */
function heroTint(anime) {
  const tint = artTint(anime.colour);
  if (!tint) return '';
  return ` style="--art:${tint.raw};--art-on-dark:${tint.onDark};--art-on-light:${tint.onLight}"`;
}

/**
 * Ratings for a batch of titles, from /api/ratings.
 *
 * Batched because "show me another" walks the list, so fetching the next
 * twenty along with the one on screen makes every later card instant at no
 * extra cost — one request either way. Only ids not already known are asked
 * for, and a failure is never cached.
 *
 * Never throws. The site worked without ratings before this existed and has to
 * keep working without them: if the request fails, or the database is not
 * bound, the row simply stays quiet.
 */
async function loadRatings(ids) {
  const wanted = [...new Set(ids.map(Number).filter(Boolean))]
    .filter((id) => !ratingCache.has(id))
    .slice(0, 40);
  if (!wanted.length) return;

  try {
    const res = await fetch(`/api/ratings?ids=${wanted.join(',')}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.unavailable) return;
    if (Number.isFinite(data.floor)) ratingFloor = data.floor;
    for (const id of wanted) {
      ratingCache.set(id, data.ratings?.[id] ?? { yes: 0, total: 0 });
    }
  } catch {
    /* Offline, blocked, or the endpoint is down. Nothing is cached, so the
     * next card retries rather than inheriting the failure. */
  }
}

/** Record a vote, and move the local figure with it so the click feels done. */
async function castVote(id, liked) {
  const key = String(id);
  if (myVotes.get(key) === liked) return;         // same answer; nothing to send

  const was = myVotes.get(key);
  rememberVote(key, liked);

  // Optimistic: shift the cached tally the way the server is about to.
  const tally = ratingCache.get(Number(id));
  if (tally) {
    if (was === undefined) tally.total += 1;
    if (was === true) tally.yes -= 1;
    if (liked) tally.yes += 1;
  }

  try {
    await fetch('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voter: voterId(), anime: Number(id), liked }),
    });
  } catch {
    /* The vote is remembered locally either way. Losing one to a dropped
     * request is not worth an error message on a card someone is skimming. */
  }
}

/**
 * The recommend row: what other people said, and the ask.
 *
 * One row holding both, always rendered, so it is a single reserved block
 * rather than two things that can each appear and shove the buttons below
 * them. Same rule as the badge row and the trailer slot.
 *
 * The figure is deliberately quiet until it has something to say. Below the
 * floor it reports the count rather than a percentage — "100% would recommend"
 * off one vote looks like data and is not — and at zero it says nothing at
 * all, because "no ratings yet" on every card in an empty database is noise,
 * and the ask sitting next to it already implies it.
 */
function recommendRow(anime) {
  const mine = myVotes.get(String(anime.id));
  return `
        <div class="recommend">
          <span class="recommend-figure" id="recommend-figure">${esc(recommendText(anime.id))}</span>
          <span class="recommend-ask">
            <span class="recommend-label">Recommend it?</span>
            <button class="vote-btn${mine === true ? ' vote-on' : ''}" type="button"
              data-action="vote" data-id="${esc(anime.id)}" data-vote="up"
              aria-pressed="${mine === true}">Yes</button>
            <button class="vote-btn${mine === false ? ' vote-on' : ''}" type="button"
              data-action="vote" data-id="${esc(anime.id)}" data-vote="down"
              aria-pressed="${mine === false}">No</button>
          </span>
        </div>`;
}

/** What the figure says for one title, given what is known right now. */
function recommendText(id) {
  const tally = ratingCache.get(Number(id));
  if (!tally || !tally.total) return '';
  if (tally.total < ratingFloor) {
    return `${tally.total} rating${tally.total === 1 ? '' : 's'} so far`;
  }
  return `${Math.round((tally.yes / tally.total) * 100)}% would recommend`
    + ` · ${tally.total.toLocaleString()} ratings`;
}

/**
 * Where to watch, from AniList's per-title streaming links.
 *
 * **It arrives with the synopsis rather than from the catalogue.** TMDB used
 * to supply this at build time, which meant a separate twenty-minute refresh
 * pass, a second credential, and listings that went stale between rebuilds.
 * AniList carries the same thing on the request the card already makes for
 * the synopsis, so it costs no extra call and is current — and it reaches
 * 69% of titles against TMDB's 50%, measured on an even 600-title sample
 * across the whole ranking range.
 *
 * **Which is why the row is a fixed height in the stylesheet.** It used to be
 * filled synchronously from the catalogue, so it could wrap freely. Now it
 * fills a moment later, and a row that grows when the request lands would
 * shove every button under it — the jitter the whole card is built to avoid.
 *
 * Rendered from `anime.streams` when that is already known, so returning to
 * a card whose details are cached shows the listings immediately rather than
 * blinking through the empty state again.
 */
function watchRow(anime) {
  return `
    <div class="watch">
      <span class="watch-label">Watch on</span>
      <span class="watch-services" id="hero-services">${servicesMarkup(anime.streams)}</span>
    </div>`;
}

/* Fade the right edge when the services run past the room available, so a chip
   cut mid-word reads as "there is more" rather than as a broken card. Only a
   measurement can tell: names run from "iQ" to "Amazon Prime Video", so no
   count cap fits every case, and the row cannot grow a second line. */
function markClipped(el) {
  el.classList.toggle('watch-clipped', el.scrollWidth > el.clientWidth);
}

/** `undefined` means "not fetched yet" and renders as nothing; `[]` means asked and none. */
function servicesMarkup(streams, failed = false) {
  if (!streams) {
    return failed
      ? '<span class="service service-none">Listings unavailable just now</span>'
      : '';
  }
  if (!streams.length) {
    return '<span class="service service-none">No listing found</span>';
  }
  return streams.slice(0, MAX_SERVICES).map((l) =>
    `<a class="service" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.site)}</a>`
  ).join('');
}

/** Compact completion figure for the grid, so cards compare on the same axis. */
function miniCompletion(anime) {
  const rate = completion(anime);
  if (!rate) return '';
  return ` · <span class="mini-finished">${rate.finished}% finished</span>`;
}

/** The completion figure as a stat block, or an honest reason it's absent. */
function completionStat(anime) {
  const rate = completion(anime);

  if (rate) {
    let title = `${rate.finished}% of the ${rate.started.toLocaleString()} people who started it finished it`
      + `; ${rate.dropped}% dropped it`;

    // Show how it compares to its own length class, so long shows aren't
    // silently penalised for being long.
    let marker = '';
    if (rate.residual !== null && Math.abs(rate.residual) >= 3) {
      const sign = rate.residual > 0 ? '+' : '';
      const cls = rate.residual > 0 ? 'resid-up' : 'resid-down';
      marker = `<span class="resid ${cls}">${sign}${rate.residual}</span>`;
      title += `. Typical for a ${anime.episodes}-episode series is ${rate.expected}%, `
        + `so this is ${Math.abs(rate.residual)} points ${rate.residual > 0 ? 'above' : 'below'} par`;
    }

    return `<div title="${esc(title)}"><b>${rate.finished}%${marker}</b>finished it</div>`;
  }
  if (anime.status === 'air') {
    return '<div title="Still airing, so nobody can have finished it yet"><b>—</b>still airing</div>';
  }
  return '';
}

/**
 * Turn a cover's dominant colour into something readable on the card.
 *
 * AniList's colours run from near-black to pale pastel, so using them raw
 * would give unreadable text half the time. Hue and saturation carry the
 * identity of the artwork; lightness is what has to be clamped — and to a
 * different range per theme, so both are emitted and CSS picks.
 */
function artTint(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(hex || '');
  if (!m) return null;

  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // Greyscale artwork has no hue to borrow. Forcing a saturation floor would
  // invent one — hue defaults to 0, so black-and-white covers came out pink.
  // Better to decline and let the card keep the site accent.
  if (s < 0.12) return null;

  const hue = Math.round(h * 360);
  const sat = Math.round(Math.min(0.85, s) * 100);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  return {
    raw: `#${m[1]}`,
    onDark: `hsl(${hue} ${sat}% ${clamp(Math.round(l * 100), 58, 76)}%)`,
    onLight: `hsl(${hue} ${sat}% ${clamp(Math.round(l * 100), 26, 42)}%)`,
  };
}

function badges(anime) {
  const out = [];
  if (anime.gem) {
    out.push('<span class="badge badge-gem" title="Highly rated, but comparatively few people have watched it">Hidden gem</span>');
  }
  if (anime.status === 'air') {
    out.push('<span class="badge badge-airing">Currently airing</span>');
  } else if (anime.status === 'soon') {
    out.push('<span class="badge badge-airing">Not yet aired</span>');
  }
  return out.join('');
}

function trimSynopsis(text) {
  if (!text) return '';
  const cleaned = text.replace(/\s*\[Written by MAL Rewrite\]\s*$/i, '').trim();
  return cleaned.length > 340 ? `${cleaned.slice(0, 340).trimEnd()}…` : cleaned;
}

/* ------------------------------------------------------------------ *
 * Autocomplete
 * ------------------------------------------------------------------ */

function attachAutocomplete(input, list, onPick) {
  let items = [];
  let active = -1;
  let debounceTimer = null;
  let requestSeq = 0;

  function close() {
    list.hidden = true;
    active = -1;
  }

  function render() {
    if (!items.length) {
      list.innerHTML = '<li class="suggestions-empty">No anime found</li>';
      list.hidden = false;
      return;
    }
    list.innerHTML = items.map((anime, i) => `
      <li class="suggestion${i === active ? ' active' : ''}" role="option"
          aria-selected="${i === active}" data-index="${i}">
        <img src="${esc(anime.image)}" alt="" loading="lazy">
        <div class="suggestion-text">
          <div class="suggestion-title">${esc(anime.title)}</div>
          <div class="suggestion-meta">${anime.titleEnglish ? `${esc(anime.titleEnglish)} — ` : ''}${esc(metaLine(anime))}${anime.rank ? ` · ranked #${anime.rank}` : ''}</div>
        </div>
      </li>`).join('');
    list.hidden = false;
  }

  async function runSearch(query) {
    const seq = ++requestSeq;
    try {
      await loadCatalogue();
    } catch (error) {
      // Said in the dropdown rather than by throwing the whole page away: you
      // are mid-sentence in the search box, and replacing the view under your
      // cursor to report a failed background fetch is worse than the failure.
      if (seq !== requestSeq) return;
      list.innerHTML = `<li class="suggestions-empty">${esc(catalogueTrouble(error))}</li>`;
      list.hidden = false;
      return;
    }
    if (seq !== requestSeq) return;

    items = searchLocal(query);

    // Nothing in the catalogue — reach out to AniList and fold the result in.
    if (!items.length) {
      list.innerHTML = '<li class="suggestions-empty">Searching beyond the top 5000…</li>';
      list.hidden = false;
      try {
        const live = await searchLive(query);
        if (seq !== requestSeq) return;
        items = live.map((entry) => insertByScore(entry));
      } catch {
        if (seq !== requestSeq) return;
        items = [];
      }
    }

    active = -1;
    render();
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    if (input === searchInput) clearBtn.hidden = !input.value;
    clearTimeout(debounceTimer);
    if (query.length < 2) {
      items = [];
      close();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(query), 140);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden || !items.length) return;
      event.preventDefault();
      active = event.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      render();
      return;
    }
    if (event.key === 'Escape') return close();
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!list.hidden && items.length) pick(items[active >= 0 ? active : 0]);
      else submitFreeText(input.value.trim());
    }
  });

  list.addEventListener('mousedown', (event) => {
    const li = event.target.closest('.suggestion');
    if (!li) return;
    event.preventDefault();
    pick(items[Number(li.dataset.index)]);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  function pick(anime) {
    if (!anime) return;
    close();
    input.value = anime.title;
    if (input === searchInput) clearBtn.hidden = false;
    onPick(anime);
  }

  async function submitFreeText(query) {
    if (!query) return;
    showLoading(`Looking up “${query}”…`);
    try {
      await loadCatalogue();
    } catch (error) {
      showError(catalogueTrouble(error), () => submitFreeText(query));
      return;
    }

    let hits = searchLocal(query, 1);
    if (!hits.length) {
      try {
        const live = await searchLive(query);
        hits = live.map((entry) => insertByScore(entry));
      } catch (error) {
        showError(`Couldn't find “${query}” in the catalogue, and the lookup failed: ${error.message}`);
        return;
      }
    }
    if (!hits.length) {
      showError(`Couldn't find an anime called “${query}”.`);
      return;
    }
    onPick(hits[0]);
  }

  return { submitFreeText, close };
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

let state = { source: null, direction: 'up', list: [], index: 0, flipped: null };

function showSearchView() {
  dropPrerendered();
  resultView.hidden = true;
  searchView.hidden = false;
  searchInput.focus();
}

function showResultView() {
  dropPrerendered();
  searchView.hidden = true;
  resultView.hidden = false;
}

function showLoading(message) {
  showResultView();
  resultBody.innerHTML = `<div class="state"><div class="spinner"></div>${esc(message)}</div>`;
}

// Held aside rather than encoded in the markup: the thing worth retrying is a
// closure over whatever was being attempted, and a data- attribute cannot hold
// one.
let pendingRetry = null;

function showError(message, retry = null) {
  pendingRetry = retry;
  showResultView();
  resultBody.innerHTML = `
    <div class="state">
      <p>${esc(message)}</p>
      ${retry ? '<button class="btn" type="button" data-action="retry">Try again</button>' : ''}
      <button class="btn${retry ? ' btn-ghost' : ''}" type="button" data-action="home">Start over</button>
    </div>`;
  wireResultControls();
}

function listWords(words) {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * Explain why this entry is on screen.
 *
 * The list works through progressively looser criteria — full genres with
 * matching themes, then full genres alone, then fewer genres — and each pass
 * starts again from the source and climbs. That makes the rank jump backwards
 * at every changeover, which reads as looping unless it's spelled out. So
 * every loosening says what it dropped and that the walk restarted.
 */
function matchNote(hero, source, direction) {
  if (!hero) return '';

  const shared = hero.matchShared ?? source.genres.length;
  const total = hero.matchTotal ?? source.genres.length;
  const themeCount = hero.matchThemes ?? 0;
  const flipped = hero.matchFlipped;
  const sourceThemes = source.themes || [];
  const where = direction === 'up' ? 'higher up' : 'further down';

  /* The theme-only tier. Saying "widened to 0 of 3 genres (0%)" would be
     technically true and useless; the honest version is that this entry has no
     genres on record and got here on a theme. */
  if (shared === 0 && !hero.genres.length) {
    const common = hero.sharedThemes?.length ? hero.sharedThemes : (hero.themes || []);
    const via = common.length ? ` It shares the ${listWords(common)} theme${common.length > 1 ? 's' : ''}.` : '';
    return `${hero.title} has no genres listed on MyAnimeList, so nothing ${where}`
      + ` could match on them.${via}`;
  }

  const relaxedGenres = shared < total;
  const lostThemes = sourceThemes.length > 0 && themeCount === 0;
  const lostDemographic = Boolean(source.demographic) && !hero.matchDemographic;

  if (!relaxedGenres && !lostThemes && !lostDemographic && !flipped) return '';

  const parts = [];

  if (relaxedGenres) {
    const pct = Math.round((shared / total) * 100);
    /* A promoted entry is sitting above things that share more genres than it
       does, which looks like a bug unless the reason is on screen. Only said
       when the entry was actually promoted — plenty of candidates carry a
       signature theme without it having changed where they landed. */
    const signature = hero.matchSignature?.length ? hero.matchSignature : null;
    parts.push(
      `Nothing ${where} shares all ${total} genres, so the search widened to `
      + `${shared} of ${total} (${pct}%)`
      + (signature
        ? `, and this one came up first because few shows share its `
          + `${listWords(signature)} theme${signature.length > 1 ? 's' : ''}`
        : '')
    );
  } else if (lostThemes || lostDemographic) {
    // Name whichever signals ran out, so the jump back is accounted for.
    const dropped = [];
    if (lostDemographic) dropped.push(`the ${source.demographic} demographic`);
    if (lostThemes) {
      dropped.push(`the ${listWords(sourceThemes)} theme${sourceThemes.length > 1 ? 's' : ''}`);
    }
    parts.push(
      `No more matches ${where} share ${listWords(dropped)}, `
      + `so the search widened to genre matches only`
    );
  }

  // One clause about movement, not two. Backtracking and changing direction
  // both describe going the other way, and stacking them reads as a stutter.
  if (hero.matchBacktrack) {
    parts.push(parts.length
      ? 'and the climb is exhausted, so this drops back to nearer matches it passed over'
      : 'The climb is exhausted, so this drops back to nearer matches it passed over');
  } else if (flipped) {
    parts.push(parts.length
      ? `and walks ${flipped} instead`
      : `Nothing ${where} matches closely enough, so this walks ${flipped} instead`);
  }

  return `${parts.join(' ')}.`;
}

const FORMAT_HINTS = {
  TV: 'Television series',
  ONA: 'Web release — includes most donghua',
  OVA: 'Direct-to-video',
};

function directionToggle(direction) {
  return `
    <div class="controls">
      <div class="direction" role="group" aria-label="Ranking direction">
        <button type="button" data-action="direction" data-value="up" aria-pressed="${direction === 'up'}">Ranked higher ↑</button>
        <button type="button" data-action="direction" data-value="down" aria-pressed="${direction === 'down'}">Ranked lower ↓</button>
      </div>
      <!-- Second in the row on purpose. The direction toggle leaves 104px
           spare beside it at 360px and the axis and format groups already
           share the line below, so putting the chip here costs no vertical
           space at all — the block stays 68px, measured in the browser at
           320, 360, 375 and 414. Appended at the end it would wrap to a
           third row, which is the thing this must not do. -->
      <div class="direction" role="group" aria-label="Release years to recommend">
        <button type="button" data-action="modern" aria-pressed="${modernOnly}"
          title="Leave out anything released before ${MODERN_FROM} — 41% of the catalogue">${MODERN_FROM} or later</button>
      </div>
      <div class="direction" role="group" aria-label="Which ranking to climb">
        <button type="button" data-action="axis" data-value="rank" aria-pressed="${axis === 'rank'}"
          title="MyAnimeList's score ranking">MAL rank</button>
        <button type="button" data-action="axis" data-value="completion" aria-pressed="${axis === 'completion'}"
          title="How well a show holds the people who start it, corrected for length">Kept watching</button>
      </div>
      <div class="direction formats" role="group" aria-label="Formats to recommend">
        ${ALL_FORMATS.map((f) => `
          <button type="button" data-action="format" data-value="${f}"
            aria-pressed="${formats.has(f)}"
            title="${FORMAT_HINTS[f]}">${f}</button>`).join('')}
      </div>
    </div>`;
}

function renderResult() {
  const { source, direction, list, index } = state;
  const hero = list[index];

  // The list spans match levels and both directions, so these describe the
  // entry currently on screen rather than the list as a whole.
  const flipped = hero?.matchFlipped ?? null;
  const shown = flipped || direction;

  // Peers of what's on screen. The full list runs on into weaker matches so
  // "show me another" has somewhere to go, but the grid shouldn't advertise
  // partial matches while closer ones are still on offer.
  const more = list
    .filter((a, i) => i !== index
      && a.matchShared === hero?.matchShared
      && a.matchFlipped === flipped)
    .slice(0, 6);

  const genreTags = source.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')
    + (source.demographic ? `<span class="tag tag-demo">${esc(source.demographic)}</span>` : '')
    + (source.themes || []).map((t) => `<span class="tag tag-plain">${esc(t)}</span>`).join('');
  // Show the source's own figure on whichever axis is being climbed.
  const sourceRate = completion(source);
  const sourceCompletion = sourceRate ? `, ${sourceRate.finished}% finished it` : '';

  const because = `
    <p class="because">Because you watched <strong>${esc(source.title)}</strong> — ranked ${esc(rankLabel(source))}${source.score ? `, scored ${esc(source.score)}` : ''}${sourceCompletion}</p>
    <div class="genre-row">${genreTags}</div>
    ${directionToggle(direction)}`;

  if (!hero) {
    const where = direction === 'up' ? 'higher up' : 'further down';
    /* An emptied walk has to name the filter that emptied it. "Nothing shares
       these genres" is false when something did share them and a filter took
       it away, and it reads as the matcher being broken rather than as a
       choice the viewer made. Both filters can be responsible at once. */
    let why;
    if (watchedSkipped && yearSkipped) {
      why = `Everything ${where} the rankings that shares these genres has been filtered out — ${watchedSkipped} already on your watched list, ${yearSkipped} released before ${MODERN_FROM}. Try the other direction, or relax one of those.`;
    } else if (watchedSkipped) {
      why = `Everything ${where} the rankings that shares these genres is already on your watched list — ${watchedSkipped} of them. Try the other direction, or clear the list from the home page.`;
    } else if (yearSkipped) {
      why = `Everything ${where} the rankings that shares these genres was released before ${MODERN_FROM} — ${yearSkipped} of them. Try the other direction, or switch off “${MODERN_FROM} or later”.`;
    } else {
      why = `Nothing ${where} the rankings shares these genres. Try the other direction.`;
    }
    resultBody.innerHTML = `${because}<div class="state">${esc(why)}</div>`;
    wireResultControls();
    return;
  }

  const fromPos = positionOf(source);
  const toPos = positionOf(hero);
  const climbed = fromPos && toPos ? Math.abs(fromPos - toPos) : null;
  const axisWord = axis === 'completion' ? 'for keeping people watching' : 'in the rankings';

  // "Watch this next" oversells a result the walk fell back to. Only claim it
  // when the pick actually moved the way you asked.
  const improved = fromPos && toPos
    ? (direction === 'up' ? toPos < fromPos : toPos > fromPos)
    : true;

  const relaxNote = matchNote(hero, source, direction);

  // A source pulled in live has no place in the ranked list, so the "next one
  // up" can be a long way up. Say so rather than presenting it as a small step.
  const outsideNote = !source.local
    ? `${esc(source.title)} isn't in the ranked catalogue — it's a film, an OVA, a later season, or outside the top ${catalogueMeta?.scanned ?? 8000}. This is the nearest match by score, so it may be a big jump rather than a small step up.`
    : '';

  const axisNote = state.axisFellBack
    ? `${esc(source.title)} has no completion figure — it's still airing, or too few people have watched it — so this uses the MAL ranking instead.`
    : '';

  /* Say when the watched list is why the answer changed.
   *
   * The count already existed and was used in exactly one place: the branch
   * that runs when the list emptied the walk completely, where "nothing shares
   * these genres" would have been a lie. When the list removes only *some*
   * candidates the page said nothing at all — and that is the common case.
   * Logged in, GATE: Jieitai returns Slayers, because Moonlit Fantasy,
   * Drifters, Berserk: Ougon Jidai-hen and Juuni Kokuki are all already
   * watched. That is correct and reads as the matcher being broken. Found by
   * the owner clicking through the live site, and it cost a round of debugging
   * the page could have answered in one line.
   *
   * **Not "closer matches", which is what the working note first said.** Of
   * the four GATE skips, only Moonlit Fantasy is nearer than the Slayers it
   * served; the other three are better matches that lost on distance. The
   * honest claim is that they matched and you have seen them, not that they
   * were nearer. */
  /* There is deliberately no matching note for the year chip, and the
     asymmetry is the point. The watched list is invisible state built up over
     months, so its effect has to be explained. The chip is on screen directly
     above the card with its own state showing, and it was just pressed — so
     "684 shows released before 2010 were skipped" tells nobody anything they
     did not already know, and 684 is the ordinary size of that number rather
     than an outlier. The format filter is visible in the same way and is
     silent for the same reason. `yearSkipped` still exists, because an
     *emptied* walk must name the filter that emptied it. */
  const watchedNote = hero && watchedSkipped
    ? `${watchedSkipped} ${watchedSkipped === 1 ? 'show that matched is' : 'shows that matched are'}`
      + ` already on your watched list, so ${watchedSkipped === 1 ? 'it was' : 'they were'} skipped.`
    : '';

  resultBody.innerHTML = `${because}

    <!-- hero-has-banner is unconditional: a third of entries have no banner
         image, and letting the card be 150px shorter for those made the
         action buttons jump between results, which is felt most when clicking
         "show me another" repeatedly. There is always a banner strip now —
         the show's own key-art colour when there is no image for it. -->
    <article class="hero hero-has-banner"${heroTint(hero)}>
      ${hero.banner
        ? `<div class="hero-banner" style="background-image:url('${esc(hero.banner)}')" role="presentation"></div>`
        : `<div class="hero-banner hero-banner-blank" role="presentation"></div>`}
      <div class="hero-main">
      <img class="hero-poster" src="${esc(hero.image)}" alt="${esc(hero.title)} poster">
      <div class="hero-body">
        <!-- Grouped so the phone layout can lift the whole identity block above
             the artwork. On a 14 Pro Max the key art alone is ~335px, which put
             the title roughly 120px below the fold. -->
        <div class="hero-head">
        <p class="eyebrow">${improved ? 'Watch this next' : 'Closest match'}</p>
        <h2>${esc(hero.title)}</h2>
        <!-- Rendered even when empty: badges hit about a tenth of cards, and
             letting the row come and go moved every button below it. -->
        <div class="badge-row">${badges(hero)}</div>
        ${climbed ? `<p class="alt-title">${climbed} ${climbed === 1 ? 'place' : 'places'} ${shown === 'up' ? 'higher' : 'lower'} ${axisWord}</p>` : ''}
        <div class="stats">
          <div><b>${esc(hero.score ?? '—')}</b>score</div>
          <div><b>${hero.rank ? `#${esc(hero.rank)}` : '—'}</b>ranked</div>
          <!-- An em-dash, not a question mark: every other unknown on this row
               renders as one, and the cell beside this already says "still
               airing", which is the actual reason a count is missing. -->
          <div><b>${esc(hero.episodes ?? '—')}</b>episodes</div>
          <div><b>${esc(hero.type ?? '—')}</b>${esc(hero.year ?? '')}</div>
          ${completionStat(hero)}
          ${hero.studios.length ? `<div class="stat-studio" title="${esc(hero.studios[0])} — animation studio"><b>${esc(hero.studios[0])}</b>studio</div>` : ''}
        </div>
        </div>
        <div class="genre-row">
          ${hero.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
          ${hero.demographic ? `<span class="tag tag-demo${hero.matchDemographic ? ' tag-shared' : ''}"${hero.matchDemographic ? ` title="Same demographic as ${esc(source.title)}"` : ''}>${esc(hero.demographic)}</span>` : ''}
          ${(hero.themes || []).map((t) => {
            const shared = (hero.sharedThemes || []).includes(t);
            return `<span class="tag tag-plain${shared ? ' tag-shared' : ''}"${shared ? ` title="Also a theme of ${esc(source.title)}"` : ''}>${esc(t)}</span>`;
          }).join('')}
        </div>
        <p class="synopsis${hero.synopsis ? '' : ' synopsis-pending'}" id="hero-synopsis">${esc(trimSynopsis(hero.synopsis))}</p>
        ${watchRow(hero)}
        ${recommendRow(hero)}
        <div class="hero-actions">
          <a class="btn" href="${esc(hero.url)}" target="_blank" rel="noopener">Open on MyAnimeList</a>
          <button class="btn btn-ghost" type="button" data-action="shuffle">Show me another</button>
          <button class="btn btn-ghost" type="button" data-action="seen" data-id="${esc(hero.id)}">Seen it too — drop it</button>
          <button class="btn btn-ghost" type="button" data-action="anchor" data-id="${esc(hero.id)}">Start from this instead</button>
          <!-- Last on purpose. The slot is always rendered so the row keeps its
               width — it used to be injected when the AniList fetch returned,
               shifting every button sideways — but reserved space at the front
               leaves a hole before the first button. At the end it falls where
               the row already runs out. -->
          <span id="trailer-slot"><button
            class="btn btn-play${hero.trailer ? '' : ' btn-reserved'}"
            type="button" data-action="trailer">▶ Trailer</button></span>
        </div>
      </div>
      </div>
    </article>

    <!-- Below the card, not above it.
         These three are all conditional, and sitting between the toggles and
         the card meant their presence or absence moved the card and every
         button in it — the same jitter as the banner and the trailer slot, but
         worse, because a note appears exactly when the result changed in a way
         worth reading. Under the card they explain the result you have just
         been shown without ever moving it. -->
    ${axisNote ? `<div class="note">${axisNote}</div>` : ''}
    ${outsideNote ? `<div class="note">${outsideNote}</div>` : ''}
    ${relaxNote ? `<div class="note">${esc(relaxNote)}</div>` : ''}
    ${watchedNote ? `<div class="note">${esc(watchedNote)}</div>` : ''}

    ${more.length ? `
      <p class="section-title">Others further ${shown === 'up' ? 'up' : 'down'} the list</p>
      <div class="more-grid">
        ${more.map((anime) => `
          <button class="mini-card" type="button" data-action="show" data-id="${esc(anime.id)}">
            <img src="${esc(anime.image)}" alt="" loading="lazy">
            <div class="mini-card-body">
              <div class="mini-card-title">${esc(anime.title)}</div>
              <div class="mini-card-meta">${esc(metaLine(anime))}${anime.rank ? ` · #${esc(anime.rank)}` : ''}${miniCompletion(anime)}</div>
              ${badges(anime) ? `<div class="badge-row">${badges(anime)}</div>` : ''}
            </div>
          </button>`).join('')}
      </div>` : ''}
  `;

  wireResultControls();

  /* Synopses aren't in the catalogue; pull just this one, lazily — but not
   * instantly. Clicking through quickly used to fire an AniList request per
   * card, several a second, which is how the rate limiting starts. Waiting a
   * moment first means a card you skimmed past never costs a request, and the
   * ones you actually stop on still fill in imperceptibly. */
  /* Ratings for this card and the twenty behind it, in one request.
   *
   * "Show me another" walks the list, so fetching ahead makes every later card
   * instant for the same single request. Fired after the card is on screen and
   * never awaited: the card is complete without it, and the row is already
   * holding its height. */
  {
    const ahead = state.list.slice(state.index, state.index + 21).map((a) => a.id);
    loadRatings([hero.id, ...ahead]).then(() => {
      if (state.list[state.index]?.id !== hero.id) return;   // moved on already
      const figure = $('recommend-figure');
      if (figure) figure.textContent = recommendText(hero.id);
    });
  }

  if (!hero.synopsis || hero.trailer === undefined) {
    setTimeout(() => {
      if (state.list[state.index]?.id !== hero.id) return;   // moved on already

      fetchDetails(hero).then(({ synopsis, trailer, streams, failed }) => {
        if (state.list[state.index]?.id !== hero.id) return;
        hero.synopsis = synopsis;
        hero.trailer = trailer;
        /* Left undefined on failure rather than set to empty, so the next
           visit asks again instead of inheriting "no listing" for the rest of
           the session — the same rule as the synopsis above it. */
        if (streams) hero.streams = streams;

        const services = $('hero-services');
        if (services) {
          services.innerHTML = servicesMarkup(streams, failed);
          markClipped(services);
        }

        const el = $('hero-synopsis');
        if (el) {
          el.classList.remove('synopsis-pending');
          /* Keep the element even when nothing came back — removing it
             collapsed the reserved height and pulled every button up. Say
             which kind of nothing it is, so five blank lines don't read as a
             broken card. */
          el.classList.toggle('synopsis-none', !synopsis);
          if (synopsis) el.textContent = trimSynopsis(synopsis);
          else el.textContent = failed ? 'Synopsis unavailable just now.' : 'No synopsis on record.';
        }

        // The slot is already there holding its width; this only reveals it.
        const button = $('trailer-slot')?.querySelector('button');
        if (button && trailer) button.classList.remove('btn-reserved');
      });
    }, 220);
  }
}

/**
 * Swap the banner for the player, or insert one above the card if this show
 * has no banner. Nothing is embedded until asked — a YouTube iframe per result
 * would be a lot of third-party weight for something most people won't click.
 */
function playTrailer() {
  const hero = state.list[state.index];
  if (!hero?.trailer) return;

  const card = resultBody.querySelector('.hero');
  if (!card) return;

  const banner = card.querySelector('.hero-banner');
  if (banner) {
    banner.outerHTML = trailerEmbed(hero.trailer);
  } else {
    card.insertAdjacentHTML('afterbegin', trailerEmbed(hero.trailer));
  }
  card.classList.add('hero-playing');
  // Hide rather than remove: emptying the slot pulled the remaining buttons
  // leftwards the moment the video started.
  $('trailer-slot')?.querySelector('button')?.classList.add('btn-reserved');
}

function wireResultControls() {
  resultBody.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;

      if (action === 'home') { goHome(); return; }

      if (action === 'retry') {
        const again = pendingRetry;
        pendingRetry = null;
        if (again) again();
        return;
      }

      if (action === 'trailer') { playTrailer(); return; }

      if (action === 'direction') {
        if (el.dataset.value === state.direction) return;
        recommendFor(state.source, el.dataset.value, { chain: true });
        return;
      }

      if (action === 'axis') {
        if (el.dataset.value === axis) return;
        axis = el.dataset.value;
        recommendFor(state.source, state.direction, { chain: true });
        return;
      }

      if (action === 'format') {
        const format = el.dataset.value;
        // Turning the last one off would leave nothing to recommend, so the
        // final format stays on rather than silently emptying the results.
        if (formats.has(format) && formats.size === 1) return;
        if (formats.has(format)) formats.delete(format);
        else formats.add(format);
        saveFormats();
        recommendFor(state.source, state.direction, { chain: true });
        return;
      }

      if (action === 'modern') {
        // No "last one on" guard is needed here, unlike the formats: turning
        // this on can empty a walk, but turning it *off* always widens, so
        // there is never a state with no way back.
        modernOnly = !modernOnly;
        saveModernOnly();
        recommendFor(state.source, state.direction, { chain: true });
        return;
      }

      if (action === 'shuffle') {
        if (state.list.length < 2) return;
        state.index = (state.index + 1) % state.list.length;
        renderResult();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      // Show a different entry from the list the anchor already produced.
      if (action === 'show') {
        const at = state.list.findIndex((a) => a.id === Number(el.dataset.id));
        if (at !== -1) {
          state.index = at;
          renderResult();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      // Drop this one and re-walk from the same anchor. The button says "seen
      // it", so it is taken at its word and remembered for good rather than
      // just for this chain.
      if (action === 'seen') {
        const id = Number(el.dataset.id);
        chainHistory.add(id);
        markWatched([id]);
        renderWatchedBar();
        refreshFromAnchor();
        return;
      }

      /* A vote. The buttons and the figure update immediately and the request
       * goes out behind them: a rating is not worth making anyone wait for,
       * and losing one to a dropped connection matters less than a card that
       * feels stuck. The answer is remembered locally either way, so the
       * buttons still show it on the way back. */
      if (action === 'vote') {
        const id = Number(el.dataset.id);
        const liked = el.dataset.vote === 'up';
        const row = el.closest('.recommend');

        castVote(id, liked);

        for (const button of row?.querySelectorAll('.vote-btn') || []) {
          const on = (button.dataset.vote === 'up') === liked;
          button.classList.toggle('vote-on', on);
          button.setAttribute('aria-pressed', String(on));
        }
        const figure = row?.querySelector('.recommend-figure');
        if (figure) figure.textContent = recommendText(id);
        return;
      }

      // Deliberately make this the new anchor.
      if (action === 'anchor') {
        const next = byId.get(Number(el.dataset.id));
        if (next) recommendFor(next, state.direction);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Main flow
 * ------------------------------------------------------------------ */

/** Anime already dismissed against the current anchor, so they don't come back. */
let chainHistory = new Set();

/**
 * Re-run the walk against the anchor the user actually chose.
 *
 * Every recommendation is matched against that one anime, not against the last
 * thing shown — otherwise the results drift: Toradora! -> Sakura-sou -> Gosick
 * -> Princess Tutu, where the far end has little to do with where you started.
 */
function refreshFromAnchor() {
  const { source, direction } = state;
  const { list, flipped } = walkRankings(source, direction, chainHistory);
  state = { ...state, list, flipped, index: 0 };
  renderResult();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function recommendFor(source, direction = 'up', { push = true, chain = false } = {}) {
  if (!source) return;

  if (!source.genres.length) {
    showError(`No genres are listed for “${source.title}”, so there's nothing to match on.`);
    return;
  }

  // A fresh search starts a new chain; pivoting continues the existing one.
  if (!chain) chainHistory = new Set();
  chainHistory.add(source.id);

  // An airing show, or one too few people have watched, has no place on the
  // completion axis — so there's nothing to walk. Fall back and say so.
  let axisFellBack = false;
  if (axis === 'completion' && source.completionPos == null) {
    axis = 'rank';
    axisFellBack = true;
  }

  if (push) {
    const url = urlFor(source, direction);
    if (location.pathname + location.search !== url) {
      history.pushState({ id: source.id, dir: direction }, '', url);
    }
  }

  const { list, flipped } = walkRankings(source, direction, chainHistory);
  state = { source, direction, list, index: 0, flipped, axisFellBack };
  showResultView();
  renderResult();
  window.scrollTo({ top: 0 });
}

function goHome() {
  /* An absolute path, not './'. From /anime/52991/sousou-no-frieren a relative
     './' resolves to /anime/52991/ — harmless only while every URL on the site
     sat at the root. */
  history.pushState({}, '', '/');
  $('mini-input').value = '';
  showSearchView();
}

/* ------------------------------------------------------------------ *
 * The watched list: import, count, clear
 * ------------------------------------------------------------------ */

/* Statuses that mean you have already met the show. "Plan to Watch" is
   deliberately not among them — you have not seen it, so it should still be
   recommendable, and for most lists it is the largest category by far. */
const WATCHED_STATUSES = new Set(['Completed', 'Watching', 'On-Hold', 'Dropped']);

/** MyAnimeList hands you a .xml.gz, so sniff the bytes rather than the name. */
async function readExportFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot unzip the file. Unzip it yourself and pick the .xml.');
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buffer);
}

function parseExport(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error("That file couldn't be read as a MyAnimeList export.");
  }
  const entries = doc.querySelectorAll('anime');
  if (!entries.length) throw new Error('No anime entries found in that file.');

  const ids = [];
  const scored = [];
  let planned = 0;
  for (const node of entries) {
    const id = Number(node.querySelector('series_animedb_id')?.textContent);
    const status = node.querySelector('my_status')?.textContent?.trim();
    if (!Number.isFinite(id) || id <= 0) continue;
    if (status && !WATCHED_STATUSES.has(status)) { planned += 1; continue; }
    ids.push(id);

    /* The score was sitting in this same node all along, ignored.
     *
     * **Zero means "not rated", not "terrible."** MyAnimeList writes 0 for
     * every unscored entry, and counting those as a 0/10 would drag every
     * average on the site toward the floor while looking like real opinions.
     *
     * Only titles in the catalogue are kept. A full list is mostly films,
     * sequels and specials this site does not carry, and there is no point
     * sending rows the server would discard -- or showing someone a number
     * that overstates what they are actually contributing. */
    const score = Number(node.querySelector('my_score')?.textContent);
    if (Number.isInteger(score) && score >= 1 && score <= 10 && byId.has(id)) {
      scored.push({ anime: id, score });
    }
  }
  return { ids, planned, scored };
}

/**
 * Ask whether to share the scores just read out of an import.
 *
 * **Asked after the file is parsed, never before.** By this point the export
 * has been read entirely on this machine and nothing has been sent, so the
 * question can name the real number — "312 scored titles" is checkable against
 * your own file in a way that "help improve recommendations" is not.
 *
 * Unticked, and asked again on every import. A remembered yes is a decision
 * somebody made once and then stopped being aware of, which is the thing
 * consent is supposed to prevent.
 *
 * Declining costs nothing: the watched list is already saved either way, and
 * the wording says so. A refusal that breaks something is not a refusal.
 */
function offerToShare(scored) {
  const host = document.getElementById('share-offer');
  if (!host) return;

  host.innerHTML = `
    <p class="share-lead"><b>${scored.length.toLocaleString()}</b> of them have a score and are in this catalogue.
    Sharing those anonymously is what turns the ratings here into real numbers —
    a title needs ${VOTE_FLOOR} ratings before it shows a percentage at all.</p>
    <p class="share-detail"><b>Sent:</b> the show ids and your scores, labelled with a random id kept in this browser.
    <b>Not sent:</b> your name, your account, the file itself, your plan-to-watch,
    or anything not in this catalogue. You can remove them again at any time.</p>
    <p class="share-actions">
      <button class="btn btn-sm" type="button" data-share="yes">Share my ${scored.length.toLocaleString()} scores</button>
      <button class="btn btn-ghost btn-sm" type="button" data-share="no">No thanks</button>
    </p>
    <p class="share-foot">Either way, they are marked as watched on this device only.
      <a href="privacy">What this site stores</a></p>`;
  host.hidden = false;

  host.querySelector('[data-share="no"]').addEventListener('click', () => {
    host.hidden = true;
    host.innerHTML = '';
  });
  host.querySelector('[data-share="yes"]').addEventListener('click', () => {
    shareScores(scored, host);
  });
}

/**
 * Upload scores in chunks, reporting as it goes.
 *
 * Chunked because the free Workers tier allows 10ms of CPU per request and a
 * few hundred inserts would exceed it — the server caps a batch at 100 and
 * this is the client half of that same limit. A whole list can take a few
 * seconds, and a button that sits there looking broken is worse than a slow
 * one that says what it is doing.
 */
async function shareScores(scored, host) {
  const total = scored.length;
  let sent = 0;
  host.innerHTML = '<p class="share-lead" id="share-progress">Sharing…</p>';
  const progress = document.getElementById('share-progress');

  for (let at = 0; at < scored.length; at += 100) {
    const chunk = scored.slice(at, at + 100);
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voter: voterId(), votes: chunk }),
      });
      if (!res.ok) throw new Error('rejected');
      sent += chunk.length;
      for (const v of chunk) rememberVote(v.anime, v.score >= 7);
    } catch {
      /* Stop rather than hammering an endpoint that is not answering. What
         went through has gone through, and saying how much is more use than
         a bare failure. */
      if (progress) {
        progress.textContent = sent
          ? `Shared ${sent.toLocaleString()} of ${total.toLocaleString()} before the connection dropped. Try again later from the same browser.`
          : 'Could not share those just now. Your list is still saved on this device.';
      }
      renderWatchedBar();
      return;
    }
    if (progress) progress.textContent = `Sharing… ${sent.toLocaleString()} of ${total.toLocaleString()}`;
  }

  if (progress) {
    progress.innerHTML = `Shared ${total.toLocaleString()} scores. Thank you — that is a real dent in the ${VOTE_FLOOR}-rating floor. `
      + '<a href="privacy">How to remove them</a>';
  }
  ratingCache.clear();          // the figures on cards are now out of date
  renderWatchedBar();
}

/**
 * Take back every rating this browser has given.
 *
 * The privacy note promises this, and the promise is what makes the consent
 * screen credible, so it has to work rather than merely exist.
 *
 * Looped because the server removes a hundred at a time — the same 10ms CPU
 * budget that forces the upload to chunk, from the other end. Bounded so a
 * server that kept reporting work left could not spin here forever.
 */
async function forgetRatings(label) {
  let removed = 0;
  for (let pass = 0; pass < 60; pass++) {
    let data;
    try {
      const res = await fetch('/api/vote', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voter: voterId() }),
      });
      if (!res.ok) throw new Error('rejected');
      data = await res.json();
    } catch {
      if (label) {
        label.textContent = removed
          ? `Removed ${removed.toLocaleString()} before the connection dropped. Try again.`
          : 'Could not reach the server just now. Nothing was removed.';
      }
      return;
    }
    removed += data.removed || 0;
    if (label && removed) label.textContent = `Removing… ${removed.toLocaleString()}`;
    if (!data.remaining) break;
  }

  myVotes = new Map();
  try { localStorage.removeItem(MY_VOTES_KEY); } catch { /* private browsing */ }
  ratingCache.clear();
  if (label) {
    label.textContent = removed
      ? `Removed ${removed.toLocaleString()} rating${removed === 1 ? '' : 's'}. They are gone from the totals.`
      : 'You have no ratings to remove.';
  }
}

function watchedSummary() {
  const n = watched.size;
  if (!n) return 'Nothing marked as watched yet';
  return `${n.toLocaleString()} title${n === 1 ? '' : 's'} marked as watched`;
}

function renderWatchedBar() {
  const label = document.getElementById('watched-count');
  const clear = document.getElementById('clear-watched-btn');
  const forget = document.getElementById('forget-ratings-btn');
  if (label) label.textContent = watchedSummary();
  if (clear) clear.hidden = watched.size === 0;
  /* Same rule as Clear, and it was missing here. Offering to delete ratings to
     somebody who has never given one is noise at best — and since it is the
     more alarming of the two buttons, it read as a warning on a page where
     nothing has happened yet. */
  if (forget) forget.hidden = myVotes.size === 0;
}

function wireWatchedBar() {
  const input = document.getElementById('import-input');
  const importBtn = document.getElementById('import-btn');
  const clearBtn = document.getElementById('clear-watched-btn');
  const label = document.getElementById('watched-count');
  if (!input || !importBtn || !clearBtn || !label) return;

  importBtn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    label.textContent = 'Reading your list…';
    try {
      const { ids, planned, scored } = parseExport(await readExportFile(file));
      const added = markWatched(ids);
      const skipped = ids.length - added;
      label.textContent = `Added ${added.toLocaleString()} title${added === 1 ? '' : 's'}`
        + (skipped ? `, ${skipped.toLocaleString()} already on the list` : '')
        + (planned ? `. ${planned.toLocaleString()} plan-to-watch left out` : '.');
      clearBtn.hidden = watched.size === 0;
      renderWatchedBar();
      /* Ask only now, with the file already read on this machine and a real
         number to show. Asking beforehand would mean asking about a quantity
         neither of us knows yet. */
      if (scored.length) offerToShare(scored);
    } catch (error) {
      label.textContent = error.message;
    } finally {
      // Let the same file be picked again after a failed read.
      input.value = '';
    }
  });

  clearBtn.addEventListener('click', () => {
    clearWatched();
    renderWatchedBar();
  });

  /* Separate from Clear on purpose. Clearing the watched list is local and
     instant; removing ratings reaches the server and undoes something you
     contributed, and rolling the two into one button would mean people who
     wanted to tidy their list quietly withdrew their ratings too. */
  const forgetBtn = document.getElementById('forget-ratings-btn');
  if (forgetBtn) {
    forgetBtn.addEventListener('click', async () => {
      forgetBtn.disabled = true;
      label.textContent = 'Removing your ratings…';
      await forgetRatings(label);
      forgetBtn.disabled = false;
    });
  }

  renderWatchedBar();
}

/* Wire up */

const mainAutocomplete = attachAutocomplete(searchInput, $('suggestions'), (a) => recommendFor(a, state.direction));
attachAutocomplete($('mini-input'), $('mini-suggestions'), (a) => recommendFor(a, state.direction));

$('go-btn').addEventListener('click', () => mainAutocomplete.submitFreeText(searchInput.value.trim()));

$('clear-btn').addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.hidden = true;
  searchInput.focus();
});

$('random-btn').addEventListener('click', rollTheDice);

async function rollTheDice() {
  showLoading('Rolling the dice…');
  try {
    await loadCatalogue();
  } catch (error) {
    showError(catalogueTrouble(error), rollTheDice);
    return;
  }
  // Respect the format and year filters here even though this is an anchor,
  // not a recommendation: being handed a donghua right after switching ONA
  // off, or a 1979 mecha right after asking for 2010 or later, would read as
  // the toggle not working.
  const pool = ranked.filter((a) => (!a.type || formats.has(a.type))
    && !(modernOnly && a.year && a.year < MODERN_FROM));
  const pick = (pool.length ? pool : ranked)[Math.floor(Math.random() * (pool.length || ranked.length))];
  recommendFor(pick, state.direction);
}

$('home-btn').addEventListener('click', goHome);

window.addEventListener('popstate', () => routeFromUrl());

/* Whether the services overflow depends on the width, so the fade has to be
   re-judged when that changes — rotating a phone or dragging a window narrower
   otherwise leaves the row either faded when it fits or cut with no hint that
   there is more. */
let clipTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => {
    const services = $('hero-services');
    if (services) markClipped(services);
  }, 120);
});

/* The shape of a result URL.
 *
 * Results used to live at /?id=N, which meant every one of them served the
 * same document — same title, same description, and a canonical pointing back
 * at the root, which tells a crawler outright not to index it separately.
 * Google had one page to rank for a site whose whole domain is the question
 * people type into it.
 *
 * They are prerendered at /anime/<id>/<slug> now, one real document each, with
 * the title and the recommendations already in the HTML. The slug is the part
 * that earns anything — "sousou-no-frieren" in the path matches what somebody
 * searched. It is decorative to the app, which routes on the id alone, so a
 * stale or mistyped slug still resolves.
 *
 * The old `?id=N` form keeps working, because links shared before this exist
 * and must not rot. */
function slugify(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function urlFor(anime, direction) {
  const slug = slugify(anime.title);
  const path = slug ? `/anime/${anime.id}/${slug}` : `/anime/${anime.id}`;
  return direction === 'down' ? `${path}?dir=down` : path;
}

/* The prerendered block a crawler reads. Once the app has a real card up it is
   removed — a visitor should never see both. Left alone when JavaScript never
   runs, so the page still says something useful without it. */
function dropPrerendered() {
  document.getElementById('seo-content')?.remove();
}

async function routeFromUrl() {
  const params = new URLSearchParams(location.search);
  /* Path first, query second: /anime/<id>/<slug> is the canonical form and
     ?id=N is the legacy one that must keep resolving. */
  const fromPath = /^\/anime\/(\d+)/.exec(location.pathname);
  const id = fromPath ? Number(fromPath[1]) : Number(params.get('id'));
  const dir = params.get('dir') === 'down' ? 'down' : 'up';

  if (!id) {
    showSearchView();
    return;
  }

  showLoading('Loading…');
  try {
    await loadCatalogue();
  } catch (error) {
    showError(catalogueTrouble(error), () => routeFromUrl());
    return;
  }

  const source = byId.get(id);
  if (!source) {
    showError('That anime is not in the catalogue.');
    return;
  }
  recommendFor(source, dir, { push: false });
}

wireWatchedBar();

// Stamp the running build onto the page and the console. The tip jar goes in
// ahead of it, so the build marker stays last where it is looked for.
const creditLine = document.querySelector('.credit');
if (creditLine) {
  if (TIP_JAR_URL) {
    creditLine.insertAdjacentHTML('beforeend',
      ` · <a class="tip-jar" href="${esc(TIP_JAR_URL)}" target="_blank" rel="noopener">${esc(TIP_JAR_LABEL)}</a>`);
  }
  creditLine.insertAdjacentHTML('beforeend', ` · <span class="build">build ${BUILD}</span>`);
}
console.info(`whatanimeshouldiwatchnext — build ${BUILD}`);

// The rejection is handled inside loadCatalogue, which raises the notice; this
// only keeps the warm-up from counting as unhandled.
loadCatalogue().catch(() => {});
routeFromUrl();
