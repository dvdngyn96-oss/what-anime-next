/* whatanimeshouldiwatchnext
 *
 * The site runs off a local ranking catalogue (anime.json) harvested from
 * MyAnimeList's top-anime list, so search and recommendations are instant and
 * need no API at runtime. Anything outside the catalogue is fetched live from
 * AniList on demand and remembered locally, so the catalogue grows with use.
 */

const CATALOGUE_URL = 'anime.json';
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
 * only genre-sharing candidates, so ten bucket slots can span 1,500 places. */
const AFFINITY_REACH = 30;
const MAX_LOOKAHEAD = 30;    // how far ahead to look at all, for cost only

/* Bump alongside the ?v= markers in index.html. Shown on the page so it's
   obvious at a glance whether the browser is running the current script — a
   stale cached app.js has caused more confusion here than any real bug. */
const BUILD = 22;

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

let ranked = [];              // every anime, in MyAnimeList rank order
let byCompletion = [];        // the same anime, ordered by length-adjusted completion
let byId = new Map();
let catalogueMeta = null;
let providerNames = [];
let studioNames = [];

/**
 * Which country's streaming listings to show. Availability differs sharply —
 * Hulu is US-only, Amazon Prime ordering differs — so guessing wrong makes the
 * whole feature misleading. Start from the browser's locale, let it be changed,
 * and remember the choice.
 */
const REGION_KEY = 'wanx:region';
const REGIONS = { u: 'US', c: 'CA' };

let region = (() => {
  try {
    const saved = localStorage.getItem(REGION_KEY);
    if (saved === 'u' || saved === 'c') return saved;
  } catch { /* private browsing */ }
  return /-CA\b/i.test(navigator.language || '') ? 'c' : 'u';
})();

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
    tmdb: row.tm || null,
    watch: row.wp || null,
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
    providerNames = data.providers || [];
    studioNames = data.studios || [];
    ranked = data.anime.map((row) => expand(row, data.names));
    renumberRanked();
    byId = new Map(ranked.map((a) => [a.id, a]));
    markHiddenGems();
    fitCompletionCurve();
    buildCompletionOrder();

    for (const extra of loadExtras()) insertByScore(extra);
    return ranked;
  })();

  return cataloguePromise;
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
  }
}`;

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

  let details = { synopsis: '', trailer: null };
  try {
    const data = await anilist(DETAIL_QUERY, { idMal: anime.id });
    const raw = data.Media?.trailer;
    details = {
      synopsis: (data.Media?.description || '').replace(/<[^>]+>/g, '').trim(),
      // Only these two embed cleanly; anything else is treated as absent.
      trailer: raw?.id && ['youtube', 'dailymotion'].includes(raw.site)
        ? { id: raw.id, site: raw.site }
        : null,
    };
  } catch { /* leave it empty; the card copes */ }

  detailCache.set(anime.id, details);
  return details;
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
    if (!candidate.local || !candidate.genres.length) continue;
    // Belt and braces: the catalogue only holds standalone TV/OVA/ONA, but a
    // live-fetched entry could be anything.
    if (candidate.type && !ALL_FORMATS.includes(candidate.type)) continue;
    // The viewer's format filter. Entries with no type recorded are kept —
    // that is a data gap, not a format they chose to exclude.
    if (candidate.type && !formats.has(candidate.type)) continue;
    if (exclude.has(candidate.id)) continue;                   // already seen this chain
    if (sameFranchise(candidate, source)) continue;

    const shared = candidate.genres.filter((g) => want.has(g)).length;
    if (!shared) continue;

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
    const audienceClash = candidate.demographic === 'Kids' && source.demographic !== 'Kids';
    buckets[audienceClash ? Math.max(1, shared - 1) : shared].push(candidate);

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
        const earned = AFFINITY_REACH * (candidate.affinity - nearest.affinity);
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
      anime.matchShared = shared;       // so the note describes the entry on screen
      anime.matchTotal = total;
      anime.matchThemes = anime.sharedThemes.length;
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
 * Where you can stream it, for the selected country.
 *
 * The stored listing is a snapshot from the last provider run, so it links out
 * to TMDB for live data rather than pretending to be current — titles leave
 * services regularly. Absent listings say so instead of rendering nothing,
 * since "we don't know" and "not streaming" are different answers.
 */
function watchRow(anime) {
  if (!anime.tmdb) return '';

  const codes = anime.watch?.[region] ?? [];
  const services = codes.map((i) => providerNames[i]).filter(Boolean);
  const link = `https://www.themoviedb.org/tv/${anime.tmdb}/watch?locale=${REGIONS[region]}`;

  const body = services.length
    ? services.map((s) => `<span class="service">${esc(s)}</span>`).join('')
    : `<span class="service service-none">Not streaming in ${REGIONS[region]}</span>`;

  return `
    <div class="watch">
      <span class="watch-label">Watch on</span>
      ${body}
      <button class="watch-region" type="button" data-action="region"
        title="Show listings for ${region === 'u' ? 'Canada' : 'the United States'}">${REGIONS[region]}</button>
      <a class="watch-more" href="${esc(link)}" target="_blank" rel="noopener">check current</a>
    </div>`;
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
    await loadCatalogue();
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
    await loadCatalogue();

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
  resultView.hidden = true;
  searchView.hidden = false;
  searchInput.focus();
}

function showResultView() {
  searchView.hidden = true;
  resultView.hidden = false;
}

function showLoading(message) {
  showResultView();
  resultBody.innerHTML = `<div class="state"><div class="spinner"></div>${esc(message)}</div>`;
}

function showError(message) {
  showResultView();
  resultBody.innerHTML = `
    <div class="state">
      <p>${esc(message)}</p>
      <button class="btn" type="button" data-action="home">Start over</button>
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

  const relaxedGenres = shared < total;
  const lostThemes = sourceThemes.length > 0 && themeCount === 0;
  const lostDemographic = Boolean(source.demographic) && !hero.matchDemographic;

  if (!relaxedGenres && !lostThemes && !lostDemographic && !flipped) return '';

  const parts = [];

  if (relaxedGenres) {
    const pct = Math.round((shared / total) * 100);
    parts.push(
      `Nothing ${where} shares all ${total} genres, so the search widened to `
      + `${shared} of ${total} (${pct}%)`
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
    resultBody.innerHTML = `${because}
      <div class="state">Nothing ${direction === 'up' ? 'higher up' : 'further down'} the rankings shares these genres. Try the other direction.</div>`;
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

  resultBody.innerHTML = `${because}
    ${axisNote ? `<div class="note">${axisNote}</div>` : ''}
    ${outsideNote ? `<div class="note">${outsideNote}</div>` : ''}
    ${relaxNote ? `<div class="note">${esc(relaxNote)}</div>` : ''}

    <article class="hero${hero.banner ? ' hero-has-banner' : ''}"${heroTint(hero)}>
      ${hero.banner ? `<div class="hero-banner" style="background-image:url('${esc(hero.banner)}')" role="presentation"></div>` : ''}
      <div class="hero-main">
      <img class="hero-poster" src="${esc(hero.image)}" alt="${esc(hero.title)} poster">
      <div class="hero-body">
        <!-- Grouped so the phone layout can lift the whole identity block above
             the artwork. On a 14 Pro Max the key art alone is ~335px, which put
             the title roughly 120px below the fold. -->
        <div class="hero-head">
        <p class="eyebrow">${improved ? 'Watch this next' : 'Closest match'}</p>
        <h2>${esc(hero.title)}</h2>
        ${badges(hero) ? `<div class="badge-row">${badges(hero)}</div>` : ''}
        ${climbed ? `<p class="alt-title">${climbed} ${climbed === 1 ? 'place' : 'places'} ${shown === 'up' ? 'higher' : 'lower'} ${axisWord}</p>` : ''}
        <div class="stats">
          <div><b>${esc(hero.score ?? '—')}</b>score</div>
          <div><b>${hero.rank ? `#${esc(hero.rank)}` : '—'}</b>ranked</div>
          <div><b>${esc(hero.episodes ?? '?')}</b>episodes</div>
          <div><b>${esc(hero.type ?? '—')}</b>${esc(hero.year ?? '')}</div>
          ${completionStat(hero)}
          ${hero.studios.length ? `<div class="stat-studio" title="Animation studio"><b>${esc(hero.studios[0])}</b>studio</div>` : ''}
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
        <div class="hero-actions">
          <span id="trailer-slot">${hero.trailer ? '<button class="btn btn-play" type="button" data-action="trailer">▶ Trailer</button>' : ''}</span>
          <a class="btn" href="${esc(hero.url)}" target="_blank" rel="noopener">Open on MyAnimeList</a>
          <button class="btn btn-ghost" type="button" data-action="shuffle">Show me another</button>
          <button class="btn btn-ghost" type="button" data-action="seen" data-id="${esc(hero.id)}">Seen it too — drop it</button>
          <button class="btn btn-ghost" type="button" data-action="anchor" data-id="${esc(hero.id)}">Start from this instead</button>
        </div>
      </div>
      </div>
    </article>

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

  // Synopses aren't in the catalogue; pull just this one, lazily.
  if (!hero.synopsis || hero.trailer === undefined) {
    fetchDetails(hero).then(({ synopsis, trailer }) => {
      if (state.list[state.index]?.id !== hero.id) return;   // moved on already
      hero.synopsis = synopsis;
      hero.trailer = trailer;

      const el = $('hero-synopsis');
      if (el) {
        el.classList.remove('synopsis-pending');
        // Nothing came back — collapse the gap rather than leaving a blank.
        if (synopsis) el.textContent = trimSynopsis(synopsis);
        else el.remove();
      }

      // The button only appears once we know there's something to play.
      const slot = $('trailer-slot');
      if (slot && trailer) {
        slot.innerHTML = `<button class="btn btn-play" type="button" data-action="trailer">▶ Trailer</button>`;
        slot.querySelector('button').addEventListener('click', playTrailer);
      }
    });
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
  $('trailer-slot')?.replaceChildren();
}

function wireResultControls() {
  resultBody.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;

      if (action === 'home') { goHome(); return; }
      if (action === 'trailer') { playTrailer(); return; }

      if (action === 'region') {
        region = region === 'u' ? 'c' : 'u';
        try { localStorage.setItem(REGION_KEY, region); } catch { /* fine */ }
        renderResult();
        return;
      }

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

      // Drop this one and re-walk from the same anchor.
      if (action === 'seen') {
        chainHistory.add(Number(el.dataset.id));
        refreshFromAnchor();
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
    const url = `?id=${source.id}&dir=${direction}`;
    if (location.search !== url) history.pushState({ id: source.id, dir: direction }, '', url);
  }

  const { list, flipped } = walkRankings(source, direction, chainHistory);
  state = { source, direction, list, index: 0, flipped, axisFellBack };
  showResultView();
  renderResult();
  window.scrollTo({ top: 0 });
}

function goHome() {
  history.pushState({}, '', './');
  $('mini-input').value = '';
  showSearchView();
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

$('random-btn').addEventListener('click', async () => {
  showLoading('Rolling the dice…');
  await loadCatalogue();
  // Respect the format filter here even though it is an anchor, not a
  // recommendation: being handed a donghua right after switching ONA off
  // would read as the toggle not working.
  const pool = ranked.filter((a) => !a.type || formats.has(a.type));
  const pick = (pool.length ? pool : ranked)[Math.floor(Math.random() * (pool.length || ranked.length))];
  recommendFor(pick, state.direction);
});

$('home-btn').addEventListener('click', goHome);

window.addEventListener('popstate', () => routeFromUrl());

async function routeFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = Number(params.get('id'));
  const dir = params.get('dir') === 'down' ? 'down' : 'up';

  if (!id) {
    showSearchView();
    return;
  }

  showLoading('Loading…');
  try {
    await loadCatalogue();
  } catch (error) {
    showError(error.message);
    return;
  }

  const source = byId.get(id);
  if (!source) {
    showError('That anime is not in the catalogue.');
    return;
  }
  recommendFor(source, dir, { push: false });
}

// Stamp the running build onto the page and the console.
const creditLine = document.querySelector('.credit');
if (creditLine) creditLine.insertAdjacentHTML('beforeend', ` · <span class="build">build ${BUILD}</span>`);
console.info(`whatanimeshouldiwatchnext — build ${BUILD}`);

loadCatalogue().catch(() => {});
routeFromUrl();
