/**
 * Adds "where to watch" to the catalogue: a TMDB id per title, plus the
 * streaming services carrying it in the US and Canada.
 *
 *   node add-watch-providers.mjs           # fill in anything missing
 *   node add-watch-providers.mjs --refresh # re-check providers for everything
 *
 * Kept separate from build-catalogue.mjs on purpose. TMDB ids never change, so
 * matching is a one-off cost, but availability moves — titles leave Netflix all
 * the time. This can be re-run on its own whenever the listings feel stale,
 * without paying for another hour of relation checks.
 *
 * Needs a TMDB v3 key, from TMDB_KEY or a local .tmdb-key file (gitignored).
 * The key stays here: the site ships the resulting data, never the key.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = new URL('./anime.json', import.meta.url);
const KEY_FILE = new URL('./.tmdb-key', import.meta.url);

const KEY = process.env.TMDB_KEY
  || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');

if (!KEY) {
  console.error('No TMDB key. Set TMDB_KEY or create a .tmdb-key file.');
  process.exit(1);
}

const REFRESH = process.argv.includes('--refresh');
const REGIONS = { u: 'US', c: 'CA' };
const GAP = 90;                          // ~11 req/sec, comfortably polite

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * TMDB lists every route to a service separately, so Vinland Saga comes back
 * with eight US "providers" that are really four: Netflix, Netflix Standard
 * with Ads, Crunchyroll, Crunchyroll Amazon Channel, and so on. Nobody
 * deciding what to watch needs the reseller breakdown — collapse to the
 * service itself and drop the duplicates.
 */
// Applied repeatedly, since the labels stack: "Netflix Standard with Ads"
// needs two passes to reach "Netflix". "Plus" is deliberately absent — it's
// part of the brand in Paramount+ and Disney+, not a tier.
const RESELLER_SUFFIX = /\s+(?:with Ads|Amazon Channel|Apple TV Channel|Roku Premium Channel|Standard|Basic|Premium)$/i;

function baseService(name) {
  let out = name.trim();
  for (let i = 0; i < 4 && RESELLER_SUFFIX.test(out); i++) {
    out = out.replace(RESELLER_SUFFIX, '').trim();
  }
  return out;
}

function tidyProviders(list) {
  const seen = new Set();
  const out = [];
  for (const { provider_name: name } of list) {
    const base = baseService(name);
    const key = squash(base);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(base);
  }
  return out;
}

async function tmdb(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${path}`
        + `${path.includes('?') ? '&' : '?'}api_key=${KEY}`);
      if (res.ok) return res.json();
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 404) return null;
    } catch { /* retry */ }
    await sleep(800 * (attempt + 1));
  }
  return null;
}

/**
 * Match a MAL title to TMDB.
 *
 * Tries the English title first, then the romaji, each with and without the
 * year. An exact title match wins; failing that, a single result for the right
 * year is accepted, which is what catches "Mahoutsukai Precure!" ->
 * "Witchy Precure!". Anything vaguer is left unmatched rather than guessed —
 * a wrong "where to watch" is worse than none.
 */
async function findTmdbId(entry) {
  for (const title of [entry.en, entry.t].filter(Boolean)) {
    for (const year of [entry.y, null]) {
      const data = await tmdb(`/search/tv?query=${encodeURIComponent(title)}`
        + (year ? `&first_air_date_year=${year}` : ''));
      await sleep(GAP);

      const results = data?.results ?? [];
      const exact = results.find((r) => squash(r.name) === squash(title)
        || squash(r.original_name) === squash(title));
      if (exact) return exact.id;
      if (year && results.length === 1) return results[0].id;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- */

const catalogue = JSON.parse(readFileSync(FILE, 'utf8'));

// Shared provider-name table, so entries store small indices rather than strings.
const providerNames = catalogue.providers ?? [];
const providerId = (name) => {
  let i = providerNames.indexOf(name);
  if (i === -1) { providerNames.push(name); i = providerNames.length - 1; }
  return i;
};

const todo = catalogue.anime.filter((a) => REFRESH || a.tm === undefined);
console.log(`${todo.length} of ${catalogue.anime.length} entries to process`
  + `${REFRESH ? ' (refreshing all)' : ''}`);

let matched = 0;
let withStreams = 0;
let unmatched = 0;

for (const [n, entry] of todo.entries()) {
  if (entry.tm === undefined || REFRESH) {
    // null records "we looked and found nothing", so we don't search again.
    entry.tm = entry.tm || await findTmdbId(entry) || null;
  }

  if (entry.tm) {
    matched++;
    const data = await tmdb(`/tv/${entry.tm}/watch/providers`);
    await sleep(GAP);

    const watch = {};
    for (const [key, region] of Object.entries(REGIONS)) {
      const flatrate = tidyProviders(data?.results?.[region]?.flatrate ?? []);
      if (flatrate.length) watch[key] = flatrate.map(providerId);
    }
    if (Object.keys(watch).length) { entry.wp = watch; withStreams++; }
    else delete entry.wp;
  } else {
    unmatched++;
  }

  if (n % 100 === 0 || n === todo.length - 1) {
    console.log(`  ${n + 1}/${todo.length} — ${matched} matched, ${withStreams} streamable, ${unmatched} unmatched`);
    writeFileSync(FILE, JSON.stringify({ ...catalogue, providers: providerNames }));
  }
}

catalogue.providers = providerNames;
catalogue.watchUpdated = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(catalogue));

const kb = Math.round(JSON.stringify(catalogue).length / 1024);
console.log(`\nDone. ${matched} matched to TMDB, ${withStreams} with streaming, ${unmatched} unmatched.`);
console.log(`${providerNames.length} distinct providers. Catalogue now ${kb} KB.`);
