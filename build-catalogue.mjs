/**
 * Builds anime.json — the local ranking catalogue the site runs on.
 *
 *   node build-catalogue.mjs                # scan top 8000, default
 *   node build-catalogue.mjs --depth 500    # quick test run
 *
 * The catalogue holds only things you can start watching cold:
 *   - TV series only (no movies, OVAs, ONAs, specials)
 *   - first seasons only (anything with a prequel is dropped)
 *
 * Ranks, scores, genres, themes, titles and posters all come from
 * MyAnimeList's official API. The ranking list is 500 per request; the
 * sequel check needs one request per series, which is the slow part.
 *
 * Needs a MAL client ID, from MAL_CLIENT_ID or a local .mal-client-id file
 * (gitignored — build-time only, never shipped).
 *
 * Re-run once a season.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const OUT = new URL('./anime.json', import.meta.url);
const ID_FILE = new URL('./.mal-client-id', import.meta.url);

const CLIENT_ID = process.env.MAL_CLIENT_ID
  || (existsSync(ID_FILE) ? readFileSync(ID_FILE, 'utf8').trim() : '');

if (!CLIENT_ID) {
  console.error('No MAL client ID. Set MAL_CLIENT_ID or create a .mal-client-id file.');
  process.exit(1);
}

const args = process.argv.slice(2);
const depthArg = args.indexOf('--depth');
const DEPTH = depthArg !== -1 ? Number(args[depthArg + 1]) : 8000;

const PER_REQUEST = 500;
const DETAIL_GAP = 340;          // ~3 req/sec against the detail endpoint
const HEADERS = { 'X-MAL-CLIENT-ID': CLIENT_ID };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MAL merges genres, themes and demographics into one `genres` array.
 * These are the true genres; everything else is a theme/demographic.
 */
const GENRE_IDS = new Set([
  1, 2, 5, 46, 28, 4, 8, 9, 49, 10, 26, 47, 12, 14, 7, 22, 24, 36, 30, 37, 41,
]);

/** Shounen, Seinen, Shoujo, Josei, Kids — audience, not subject matter. */
const DEMOGRAPHIC_IDS = new Set([27, 42, 25, 43, 15]);

/**
 * Formats you can start from cold.
 *
 * TV is the bulk of it, but excluding OVA and ONA outright loses genuine
 * standalone works the community rates highly — Hellsing Ultimate, FLCL,
 * Cyberpunk: Edgerunners, Yamato 2199, Takopi's Original Sin. Movies stay out:
 * they're usually either a franchise entry or a different watching decision.
 */
const WATCHABLE_TYPES = new Set(['tv', 'ova', 'ona']);

const TYPE_LABELS = { tv: 'TV', ova: 'OVA', ona: 'ONA' };

/**
 * Hand-picked exceptions, by MAL ID.
 *
 * The relation rule below is strict, and strictness costs a few genuine
 * standalone works. MAL's data cannot separate them automatically: Hellsing
 * Ultimate lists Hellsing: The Dawn as a prequel and the 2001 TV series as an
 * alternative version — structurally identical to Hunter x Hunter: Greed
 * Island, which really does need the TV series first. Relaxing the rule to
 * admit one admits the other.
 *
 * So this is deliberately a judgement call rather than a heuristic. Add IDs
 * here for works that stand on their own despite their relations; the builder
 * prints likely candidates at the end of each run.
 */
const STANDS_ALONE_ANYWAY = new Set([
  777,    // Hellsing Ultimate — manga-faithful retelling, watchable cold
  820,    // Legend of the Galactic Heroes — its "prequel" is a later side film
  35737,  // Pluto — parent_story is Astro Boy, but it's self-contained
  61469,  // Steel Ball Run — alternate continuity, new cast, new setting;
          // MAL chains it to Part 6 by production order, not by story
]);

/**
 * Does this stand on its own?
 *
 * `parent_story` means it hangs off something else — a bundled bonus episode
 * or a side story. `prequel` means something comes before it. Either way you
 * cannot start here, unless it's on the list above.
 */
function standsAlone(id, relations) {
  if (STANDS_ALONE_ANYWAY.has(id)) return true;
  const kinds = new Set((relations ?? []).map((r) => r.relation_type));
  return !kinds.has('parent_story') && !kinds.has('prequel');
}

/** Backstop for sequels whose relation data is missing or unfetchable. */
const SEQUEL_PATTERNS = [
  /\b(?:2nd|3rd|4th|5th|6th|7th|8th|9th|final)\s+season\b/i,
  // Spelled-out ordinals. Monogatari Series: Second Season slipped through on
  // the first pass: its relation lookup failed, so it was kept unverified, and
  // "Second" didn't match the numeric pattern above.
  /\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth)\s+(?:season|series|stage|arc)\b/i,
  /\bseason\s*[2-9]\b/i,
  /\bpart\s*[2-9]\b/i,
  /\b(?:ii|iii|iv|vi|vii|viii|ix)\s*$/i,
  /\bR2\b/,
  /\s[2-9]\s*$/,
];

const looksLikeSequel = (title) => SEQUEL_PATTERNS.some((re) => re.test(title));

/**
 * Recaps, digests and compilation episodes.
 *
 * The catalogue rule is "no films, specials or recaps", and MAL's `special`
 * media_type is already excluded — but plenty of recaps are typed OVA or ONA
 * and sail straight through. Chainsaw Man Recap sat at #1207 for four builds.
 *
 * "Special" on its own is unusable as a word match: Special A is a real
 * 24-episode TV series, and A Returner's Magic Should Be Special is a real
 * 12-episode one. It only signals a recap as a *trailing* word, and only on
 * OVA/ONA — the one TV compilation in the catalogue, Gundam IBO
 * Tokubetsu-hen, is caught by "Special Edition" in its English title instead.
 */
const RECAP_PATTERNS = [
  /\brecaps?\b/i,
  /\bdigests?\b/i,
  /\bcompilation\b/i,
  /\bsoushuuhen\b/i,
  /\bspecial\s+(?:edition|anime|animation)\b/i,
];

const TRAILING_SPECIAL = /\bspecials?\b\s*[!！?？.]*$/i;

function looksLikeRecap(node) {
  const titles = [node.title, node.alternative_titles?.en].filter(Boolean);
  const isTv = node.media_type === 'tv';
  return titles.some((t) => RECAP_PATTERNS.some((re) => re.test(t)) || (!isTv && TRAILING_SPECIAL.test(t)));
}

async function malFetch(url, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403) {
      console.error('  client ID rejected — check .mal-client-id');
      process.exit(1);
    }
    if (res.status === 404) return null;
    await sleep(2000 * (attempt + 1));
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * 1. Scan the ranking, keeping TV series
 * ---------------------------------------------------------------- */

const RANK_FIELDS = [
  'id', 'title', 'alternative_titles', 'mean', 'rank', 'genres', 'status',
  'num_episodes', 'media_type', 'start_season', 'num_list_users', 'main_picture',
  'studios',
].join(',');

const STATUS_CODES = {
  finished_airing: 'fin',
  currently_airing: 'air',
  not_yet_aired: 'soon',
};

console.log(`Scanning top ${DEPTH} by MAL rank…`);

const tvSeries = [];
let scanned = 0;

for (let offset = 0; offset < DEPTH; offset += PER_REQUEST) {
  const page = await malFetch(
    `https://api.myanimelist.net/v2/anime/ranking?ranking_type=all`
    + `&limit=${PER_REQUEST}&offset=${offset}&fields=${RANK_FIELDS}`
  );
  if (!page) { console.error('  page failed, stopping scan'); break; }

  for (const { node } of page.data) {
    scanned++;
    if (!WATCHABLE_TYPES.has(node.media_type)) continue;
    if (!node.rank) continue;
    tvSeries.push(node);
  }

  console.log(`  scanned ${scanned}/${DEPTH} -> ${tvSeries.length} TV series`);
  if (!page.paging?.next) break;
  await sleep(700);
}

console.log(`\n${tvSeries.length} TV series from ${scanned} ranked entries`);

/* ---------------------------------------------------------------- *
 * 2. Drop anything with a prequel
 * ---------------------------------------------------------------- */

console.log(`\nChecking each for a prequel (~${Math.round((tvSeries.length * DETAIL_GAP) / 60000)} min)…`);

const firstSeasons = [];
const allowlistCandidates = [];
let droppedByRelation = 0;
let droppedByTitle = 0;
let droppedByRecap = 0;
let unchecked = 0;

for (const [n, node] of tvSeries.entries()) {
  if (looksLikeRecap(node)) {
    // Checked before the sequel patterns and before the detail request: a
    // recap is never worth a lookup, whatever its relations say.
    droppedByRecap++;
  } else if (looksLikeSequel(node.title)) {
    droppedByTitle++;
  } else {
    // `statistics` rides along free — it's detail-only, and we're already
    // making this request for the prequel check.
    // Try harder than elsewhere: a failure here means the entry is kept
    // *unverified*, which is how a sequel gets into the catalogue.
    const detail = await malFetch(
      `https://api.myanimelist.net/v2/anime/${node.id}?fields=id,related_anime,statistics`, 4
    );

    if (!detail) {
      unchecked++;                       // couldn't verify; keep it
      firstSeasons.push(node);
    } else if (!standsAlone(node.id, detail.related_anime)) {
      droppedByRelation++;
      // Well-regarded OVA/ONA dropped on relations are the likeliest
      // allowlist candidates, so surface them rather than losing them silently.
      if (node.media_type !== 'tv' && node.rank <= 1500) {
        allowlistCandidates.push({ id: node.id, rank: node.rank, title: node.title });
      }
    } else {
      node.statistics = detail.statistics;
      firstSeasons.push(node);
    }
    await sleep(DETAIL_GAP);
  }

  if (n % 250 === 0 || n === tvSeries.length - 1) {
    console.log(`  ${n + 1}/${tvSeries.length} -> ${firstSeasons.length} kept`
      + ` (${droppedByRelation} sequels, ${droppedByTitle} by title)`);
  }
}

/* ---------------------------------------------------------------- *
 * 3. Write
 * ---------------------------------------------------------------- */

const nameIndex = [];
const nameId = (name) => {
  let i = nameIndex.indexOf(name);
  if (i === -1) { nameIndex.push(name); i = nameIndex.length - 1; }
  return i;
};

// Studios get their own table — 528 of them, and they don't mix with genres.
const studioIndex = [];
const studioId = (name) => {
  let i = studioIndex.indexOf(name);
  if (i === -1) { studioIndex.push(name); i = studioIndex.length - 1; }
  return i;
};

const trimImage = (url) => (url ? (/images\/anime\/(.+)$/.exec(url)?.[1] ?? null) : null);

/** MAL returns these as strings; null when the detail lookup failed. */
function statCounts(statistics) {
  const s = statistics?.status;
  if (!s) return null;
  return {
    w: Number(s.watching) || 0,
    c: Number(s.completed) || 0,
    h: Number(s.on_hold) || 0,
    d: Number(s.dropped) || 0,
    p: Number(s.plan_to_watch) || 0,
  };
}

const entries = firstSeasons
  .sort((a, b) => a.rank - b.rank)
  .map((node) => {
    const genres = [];
    const themes = [];
    const demographics = [];
    for (const g of node.genres ?? []) {
      if (GENRE_IDS.has(g.id)) genres.push(nameId(g.name));
      else if (DEMOGRAPHIC_IDS.has(g.id)) demographics.push(nameId(g.name));
      else themes.push(nameId(g.name));
    }
    const english = node.alternative_titles?.en;

    return {
      r: node.rank,
      i: node.id,
      t: node.title,
      ...(english && english !== node.title ? { en: english } : {}),
      s: node.mean ?? null,
      ty: TYPE_LABELS[node.media_type] ?? node.media_type,
      st: STATUS_CODES[node.status] ?? null,
      e: node.num_episodes || null,
      y: node.start_season?.year ?? null,
      m: node.num_list_users ?? null,
      im: trimImage(node.main_picture?.medium),
      g: genres,
      th: themes,
      d: demographics,
      // Raw list-status counts, kept raw so the derived metric stays tunable
      // without a rebuild: watching, completed, on-hold, dropped, plan-to-watch.
      su: (node.studios ?? []).map((x) => x.name).filter(Boolean).map(studioId),
      stats: statCounts(node.statistics),
    };
  });

/* ---------------------------------------------------------------- *
 * 3b. Key-art colour and banner from AniList
 *
 * MAL exposes neither. AniList gives the dominant colour of each cover, which
 * the site uses to theme the card to the show itself, plus a wide banner.
 * Matched on MAL ID, ~54 requests.
 * ---------------------------------------------------------------- */

/* Tags ride along with the art rather than costing a second harvest: the same
 * idMal_in page can return them, so a rebuild gets weighted tags for free.
 * add-anilist-tags.mjs exists for retrofitting an existing catalogue; this is
 * what keeps a rebuild from dropping them the way it drops tm/wp. */
const ART_QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: ANIME) {
      idMal coverImage { color } bannerImage
      tags { name rank isGeneralSpoiler isMediaSpoiler isAdult }
    }
  }
}`;

const MIN_TAG_RANK = 50;        // below this the tag is noise, not signal
const tagNames = [];
const indexOfTag = new Map();

function tagIndex(name) {
  if (!indexOfTag.has(name)) {
    indexOfTag.set(name, tagNames.length);
    tagNames.push(name);
  }
  return indexOfTag.get(name);
}

async function attachArt(rows) {
  const byMal = new Map(rows.map((r) => [r.i, r]));
  const chunks = [];
  for (let i = 0; i < rows.length; i += 50) chunks.push(rows.slice(i, i + 50));

  let colours = 0;
  let banners = 0;
  let tagged = 0;

  for (const [n, chunk] of chunks.entries()) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: ART_QUERY, variables: { ids: chunk.map((r) => r.i) } }),
      });

      if (res.status === 429) {
        await sleep((Number(res.headers.get('retry-after') || 60) + 1) * 1000);
        continue;
      }
      if (!res.ok) { await sleep(3000); continue; }

      const json = await res.json();
      for (const media of json?.data?.Page?.media ?? []) {
        const row = byMal.get(media.idMal);
        if (!row) continue;
        const colour = media.coverImage?.color;
        if (colour) { row.cl = colour.replace('#', ''); colours++; }
        const banner = /banner\/(.+)$/.exec(media.bannerImage || '')?.[1];
        if (banner) { row.bn = banner; banners++; }

        // One integer per tag: index * 10 + weight, weight = floor(rank/10)
        // clamped to 5..9. Only tags at MIN_TAG_RANK or better are kept, so
        // the units digit is never 0 and the pair always decodes cleanly.
        const tags = (media.tags ?? [])
          .filter((t) => !t.isGeneralSpoiler && !t.isMediaSpoiler && !t.isAdult && t.rank >= MIN_TAG_RANK)
          .sort((a, b) => b.rank - a.rank);
        if (tags.length) {
          row.tg = tags.map((t) => tagIndex(t.name) * 10 + Math.min(9, Math.floor(t.rank / 10)));
          tagged++;
        }
      }
      break;
    }
    if (n % 10 === 0 || n === chunks.length - 1) {
      console.log(`  art batch ${n + 1}/${chunks.length} -> ${colours} colours, ${banners} banners, ${tagged} tagged`);
    }
    await sleep(1200);
  }
  return { colours, banners, tagged };
}

console.log('\nFetching key-art colour and banners from AniList…');
const art = await attachArt(entries);

const catalogue = {
  built: new Date().toISOString(),
  source: 'MyAnimeList official API — TV series, first seasons only; art from AniList',
  count: entries.length,
  scanned,
  names: nameIndex,
  studios: studioIndex,
  // Kept apart from `names`: g/th/d index into that one, and a separate
  // vocabulary means a tag refresh can never shift a genre's index.
  tagNames,
  anime: entries,
};

const json = JSON.stringify(catalogue);
writeFileSync(OUT, json);

console.log(`\nWrote anime.json`);
console.log(`  ${entries.length} TV first seasons, ${Math.round(json.length / 1024)} KB`);
console.log(`  from ${scanned} ranked entries -> ${tvSeries.length} TV -> ${entries.length} kept`);
console.log(`  dropped ${droppedByRelation} with a prequel, ${droppedByTitle} by title pattern`);
console.log(`  dropped ${droppedByRecap} recaps, digests and compilations`);
console.log(`  ${unchecked} kept unverified (lookup failed)`);
console.log(`  ${entries.filter((e) => !e.g.length).length} without genres`);
console.log(`  ${art.colours} with a key-art colour, ${art.banners} with a banner`);
console.log(`  ${art.tagged} with AniList tags, ${tagNames.length} distinct tag names`);

const kept = {};
for (const e of entries) kept[e.ty] = (kept[e.ty] ?? 0) + 1;
console.log(`  by type: ${Object.entries(kept).map(([k, v]) => `${k} ${v}`).join(', ')}`);

if (allowlistCandidates.length) {
  console.log(`\nWell-regarded OVA/ONA dropped on relations — review for STANDS_ALONE_ANYWAY:`);
  for (const c of allowlistCandidates.sort((a, b) => a.rank - b.rank).slice(0, 30)) {
    console.log(`  ${String(c.id).padStart(6)},  // #${String(c.rank).padStart(4)}  ${c.title}`);
  }
}
console.log(`  rank span #${entries[0]?.r} … #${entries.at(-1)?.r}`);
