/* Prerender one HTML page per catalogue entry, so the site is more than a
 * single indexable document.
 *
 * **The problem this solves.** Every result lives at /?id=N and the card is
 * built by app.js after the catalogue loads, so a crawler was served the same
 * title, the same description and a canonical pointing back at the root — for
 * all 3,493 of them. Google had one page to rank for a site whose domain is an
 * exact match for the thing people type into Google. The long tail is the
 * prize: "what to watch after <show>" is thousands of low-competition queries
 * this catalogue can already answer.
 *
 * **It drives the real app.js rather than reimplementing the walk.** The
 * matcher is the highest-risk code in this project and a second copy of it
 * would drift, quietly, in a place nobody looks. So this boots index.html and
 * app.js in jsdom exactly as test/walks.mjs does, calls the same
 * walkRankings, and writes out what the page itself would show. That also
 * keeps the prerendered HTML honest: a crawler is served the same
 * recommendations a visitor gets, which is the difference between
 * prerendering and cloaking.
 *
 * Usage:
 *   node build-seo-pages.mjs --limit 20     # prototype a handful
 *   node build-seo-pages.mjs                # the whole catalogue
 */

import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).slice(0, -1);
const SITE = 'https://whatanimeshouldiwatchnext.com';
const OUT = join(ROOT, 'anime');

const argLimit = process.argv.indexOf('--limit');
const LIMIT = argLimit === -1 ? Infinity : Number(process.argv[argLimit + 1]);

/* How many recommendations to bake into the page. Enough to be a real answer
   to the question in the title, few enough that the page stays small — every
   one of these is bytes on every crawl. */
const SHOWN = 8;

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
const catalogue = JSON.parse(readFileSync(join(ROOT, 'anime.json'), 'utf8'));

/* ---------- helpers ---------- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* Latin letters and digits only, so a title in kana or hanzi collapses to
   nothing rather than to percent-encoded noise in the URL. Those entries fall
   back to the id alone, which is ugly but honest and still unique. */
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

const pathFor = (a) => {
  const slug = slugify(a.title);
  return slug ? `/anime/${a.id}/${slug}` : `/anime/${a.id}`;
};

/* ---------- boot the real app once ---------- */

const dom = new JSDOM(html, { runScripts: 'dangerously', url: `${SITE}/`, pretendToBeVisual: true });
const w = dom.window;
w.scrollTo = () => {};
// Only the catalogue is needed; nothing here should reach AniList or the API.
w.fetch = (target) => {
  const href = String(target);
  if (href.includes('anilist') || href.includes('/api/')) {
    return Promise.reject(new Error('not needed for prerender'));
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalogue) });
};

/* Reach into module scope the same way the test suite does — top-level
   const/let are lexical bindings an outside eval cannot see. */
w.eval(`${app}
window.__seo = {
  ready: loadCatalogue(),
  all: () => ranked,
  walk: (id, direction) => {
    const source = byId.get(id);
    if (!source) return null;
    const { list } = walkRankings(source, direction);
    return { source, list };
  },
  positionOf,
};`);

await w.__seo.ready;

/* ---------- page template ---------- */

function description(source, picks) {
  const named = picks.slice(0, 3).map((p) => p.title).join(', ');
  const kind = source.type === 'TV' ? 'series' : source.type;
  const base = `Finished ${source.title}? Here is what to watch next`;
  return named
    ? `${base} — ${named} and more, each a ${kind} you can start from episode one.`
    : `${base}: the next ${kind} up the rankings that shares its genres.`;
}

function pageFor(source, picks) {
  const url = `${SITE}${pathFor(source)}`;
  const title = `What to watch after ${source.title}`;
  const desc = description(source, picks);
  const alt = source.titleEnglish && source.titleEnglish !== source.title
    ? ` <span class="seo-alt">Also known as ${esc(source.titleEnglish)}.</span>` : '';

  const facts = [
    source.type,
    source.year,
    source.episodes ? `${source.episodes} episodes` : null,
    source.rank ? `ranked #${source.rank} on MyAnimeList` : null,
    source.score ? `scored ${source.score}` : null,
    source.studios?.[0],
  ].filter(Boolean).map(esc).join(' · ');

  const items = picks.map((p) => {
    const bits = [p.type, p.year, p.rank ? `#${p.rank}` : null,
      p.episodes ? `${p.episodes} episodes` : null].filter(Boolean).map(esc).join(' · ');
    const shares = p.matchShared
      ? `Shares ${p.matchShared} of ${source.genres.length} genres.`
      : 'Matched on a shared theme.';
    return `        <li>
          <a href="${esc(pathFor(p))}"><strong>${esc(p.title)}</strong></a>
          <span class="seo-meta">${bits}</span>
          <span class="seo-why">${esc(shares)}</span>
        </li>`;
  }).join('\n');

  /* The block a crawler reads. app.js removes it the moment it has built the
     real card, so a visitor never sees both — see hydration in app.js. */
  const block = `
    <div id="seo-content" class="seo-content">
      <h1>${esc(title)}</h1>
      <p class="seo-lede">${esc(source.title)} — ${facts}.${alt}</p>
      <p>${esc(desc)}</p>
      <h2>Recommendations</h2>
      <ol class="seo-list">
${items}
      </ol>
      <p class="seo-note">Ranked by MyAnimeList position, filtered to shows that share
      ${esc(source.title)}'s genres. Sequels, films and recap editions are left out, so
      everything here can be started from episode one.</p>
    </div>`;

  return html
    .replace('<title>whatanimeshouldiwatchnext</title>', `<title>${esc(title)} · whatanimeshouldiwatchnext</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(desc)}">`
    )
    .replace(
      /<link rel="canonical" href="[^"]*">/,
      `<link rel="canonical" href="${esc(url)}">`
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${esc(title)}">`
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${esc(desc)}">`
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${esc(url)}">`
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*">/,
      `<meta name="twitter:title" content="${esc(title)}">`
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*">/,
      `<meta name="twitter:description" content="${esc(desc)}">`
    )
    .replace('<main id="app">', `<main id="app">${block}`);
}

/* ---------- generate ---------- */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

const all = w.__seo.all();
const targets = all.filter((a) => a.local && a.genres.length).slice(0, LIMIT);

let written = 0;
const urls = [];
for (const source of targets) {
  const walked = w.__seo.walk(source.id, 'up');
  const picks = (walked?.list ?? []).slice(0, SHOWN);
  // A page with no recommendations on it is a thin page; skip rather than ship one.
  if (!picks.length) continue;

  const rel = pathFor(source);
  /* A directory with an index.html, not "<slug>.html". Cloudflare Pages serves
     either at the extensionless path, but python's http.server — which is what
     `npm run serve` runs — only serves the directory form. Matching them means
     the local preview is the same thing production serves, rather than a
     near-miss that hides routing bugs until deploy. */
  const file = join(ROOT, rel, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pageFor(source, picks));
  urls.push(rel);
  written += 1;
  if (written % 250 === 0) process.stderr.write(`\r${written}/${targets.length}`);
}
process.stderr.write('\r');

/* The sitemap is written here rather than by hand, because it has to list
   exactly what was generated. It used to hold a single URL, with a comment
   explaining that listing 3,493 identical documents is what duplicate content
   means — true then, and not true now: each of these is a distinct page with
   its own title, description and body.

   Real newlines inside the template rather than escapes, because these get
   written through a shell heredoc often enough that a halved backslash has
   already broken this file once. */
const today = new Date().toISOString().slice(0, 10);

const entry = (loc, priority, freq) => `  <url>
    <loc>${SITE}${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${priority}</priority>
  </url>
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Generated by build-seo-pages.mjs. Do not edit by hand — it must list exactly
  the pages that were written, or it points a crawler at documents that are
  not there.
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entry('/', '1.0', 'weekly')}${entry('/privacy', '0.3', 'yearly')}${urls.map((u) => entry(u, '0.6', 'monthly')).join('')}</urlset>
`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);

console.log(`wrote ${written} pages under /anime/`);
console.log(`skipped ${targets.length - written} with nothing to recommend`);
console.log(`sitemap.xml lists ${urls.length + 2} URLs`);
