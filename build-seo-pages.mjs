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
const GENRE_OUT = join(ROOT, 'genre');

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

/* With the trailing slash, because that is the form Cloudflare Pages actually
   serves. A page written to anime/<id>/<slug>/index.html answers 200 at
   "/anime/<id>/<slug>/" and 308-redirects "/anime/<id>/<slug>" to it — so
   without the slash the sitemap, the canonical and every internal link would
   point at a redirect. Found by calling the deployed site rather than by
   reading the code, which is how most real bugs here get found. */
const pathFor = (a) => {
  const slug = slugify(a.title);
  return slug ? `/anime/${a.id}/${slug}/` : `/anime/${a.id}/`;
};

/* An episode count, or nothing when the count says nothing.
 *
 * A film is one episode, and "1 episodes" beside "Film" is both ungrammatical
 * and information-free -- the format has already said it. Same instinct as the
 * card rendering a missing count as an em-dash rather than "? episodes":
 * say nothing rather than something empty. */
function episodeLabel(a) {
  if (!a.episodes || a.type === 'Film') return null;
  return `${a.episodes} episode${a.episodes === 1 ? '' : 's'}`;
}

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
  genres: () => moodGenres,
  excluded: () => [...MOOD_EXCLUDED],
  anchorFor: (genre) => pickMoodAnchor(genre),
  verdict: (a) => malVerdict(a),
};`);

await w.__seo.ready;

/* ---------- page template ---------- */

function description(source, picks) {
  const named = picks.slice(0, 3).map((p) => p.title).join(', ');
  const base = `Finished ${source.title}? Here is what to watch next`;
  return named
    ? `${base} — ${named} and more, each one you can start from the beginning.`
    : `${base}: the next anime up the rankings that shares its genres.`;
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
    episodeLabel(source),
    source.rank ? `ranked #${source.rank} on MyAnimeList` : null,
    source.score ? `scored ${source.score}` : null,
    source.studios?.[0],
  ].filter(Boolean).map(esc).join(' · ');

  const items = picks.map((p) => {
    const bits = [p.type, p.year, p.rank ? `#${p.rank}` : null,
      episodeLabel(p)].filter(Boolean).map(esc).join(' · ');
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
  /* Genre links, and they are the only route a crawler has into the genre
     pages besides the sitemap. 4,956 pages linking to fourteen is a strong
     internal signal; a sitemap entry on its own is a weak one. Only genres the
     picker actually offers are linked, so no page points at a URL that was
     never written. */
  const offered = new Set(w.__seo.genres());
  const genreLinks = source.genres.filter((g) => offered.has(g))
    .map((g) => `<a href="${esc(genrePathFor(g))}">${esc(g)}</a>`).join(' · ');

  const block = `
    <div id="seo-content" class="seo-content">
      <h1>${esc(title)}</h1>
      <p class="seo-lede">${esc(source.title)} — ${facts}.${alt}</p>
      ${genreLinks ? `<p class="seo-genres">More like this: ${genreLinks}</p>` : ''}
      <p>${esc(desc)}</p>
      <h2>Recommendations</h2>
      <ol class="seo-list">
${items}
      </ol>
      <p class="seo-note">Ranked by MyAnimeList position, filtered to anime that share
      ${esc(source.title)}'s genres. Sequels, side stories and recap editions are left out, so
      everything here can be started from the beginning.</p>
    </div>`;

  return html
    .replace(/<title>[^<]*<\/title>/,`<title>${esc(title)} · whatanimeshouldiwatchnext</title>`)
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

/* ---------- genre pages ---------- */

/* How many titles a genre page lists.
 *
 * An anime page shows 8, which is a recommendation. This is a "best mystery
 * anime" list, and that query wants a list rather than a suggestion — long
 * enough to be worth linking to, short enough that the page stays a page. */
const GENRE_SHOWN = 25;

const genrePathFor = (genre) => `/genre/${slugify(genre)}/`;

/* A thumbnail off MyAnimeList's own resizing endpoint rather than the full
   poster.
 *
 * These pages exist to load fast on a phone from a search result, and 25 full
 * posters is 1.4 MB of it. Measured on one title:
 *
 *   full            56,653 bytes
 *   /r/192x272/     14,975
 *   /r/100x140/      5,633
 *   /r/50x70/        2,134
 *
 * So the list costs about 141 KB of images at 2x instead of 1.4 MB. Served
 * with a srcset and `sizes="48px"`, which lets a 1x or 2x screen take the
 * 100-wide file and only a 3x screen pay for the 192.
 *
 * `im` is on all 5,017 entries -- it is the *banner* that is missing on two
 * in five, not the poster -- so there is no missing-image case to design for
 * here. */
const POSTER_W = 48;
const POSTER_H = 67;
const thumbAt = (image, size) =>
  image.replace('https://cdn.myanimelist.net/images/', `https://cdn.myanimelist.net/r/${size}/images/`);

/* The article a crawler reads and a visitor keeps.
 *
 * Unlike the anime pages, this block is NOT replaced when app.js boots — see
 * routeFromUrl. Somebody who searched "best mystery anime" came for the list,
 * and swapping it for a single recommendation card would be a bait and switch.
 * The button hands them into the walk if they want it. */
function artRowsFor(entries) {
  return entries.map((e, i) => {
    const bits = [e.type, e.year, episodeLabel(e),
      e.studios?.[0]].filter(Boolean).map(esc).join(' · ');
    /* The recommend figure where there is one. It is a better number to read
       than a score out of ten -- 98% says something a reader can act on -- but
       it is a column and never the sort: within every genre it agrees with
       MyAnimeList rank at 0.978 to 0.989, so sorting by it would produce this
       same list while implying it was something else. */
    const v = w.__seo.verdict(e);
    const pct = v ? `<span class="genre-pct">${v.pct}% would recommend</span>` : '';
    /* width and height on the element itself, not only in CSS: without them
       the row has no height until the image arrives and the whole list
       reflows as they land -- the same jitter the card is built to avoid, on
       a page somebody is already reading. alt is empty because the title is
       the link right beside it, so describing the poster would just make a
       screen reader say everything twice. */
    /* The artwork is the row, with the title over it.
     *
     * `bn` is AniList's wide banner, and it is on 344 of the 350 rows these
     * fourteen pages actually print -- 98%, because every row here is well
     * ranked. The 61% coverage figure for the whole catalogue is the wrong
     * number to design against; it is the long tail that lacks banners, and
     * the long tail does not appear on these pages.
     *
     * The six without one fall back to a flat wash of `cl`, the show's own
     * key-art colour, exactly as the card does. That colour also sits under
     * every banner, so a row is the right colour before its image arrives
     * rather than a grey hole.
     *
     * loading="lazy" is load-bearing: a banner averages 184 KB and AniList
     * serves no smaller variant, so only the rows somebody actually scrolls
     * to are ever fetched. */
    const tint = e.colour || '#3a3d42';
    const art = e.banner
      ? `<img class="genre-art" src="${esc(e.banner)}" loading="lazy" decoding="async" alt="">`
      : '';
    return `        <li style="--row-tint:${esc(tint)}">
          ${art}
          <span class="genre-row-body">
            <span class="genre-pos">${i + 1}</span>
            <span class="genre-row-text">
              <a href="${esc(pathFor(e))}"><strong>${esc(e.title)}</strong></a>
              ${e.titleEnglish && e.titleEnglish !== e.title ? `<span class="genre-alt">${esc(e.titleEnglish)}</span>` : ''}
              <span class="seo-meta">${bits}${e.rank ? ` · #${e.rank} on MyAnimeList` : ''}</span>
              ${pct}
            </span>
          </span>
        </li>`;
  }).join('\n');
}

/* The head of a listing page: index.html with its title, description,
   canonical and social tags swapped for the page's own, and the block put in
   front of the app. */
function listingPage(title, desc, url, block) {
  return html
    .replace(/<title>[^<]*<\/title>/,`<title>${esc(title)} · whatanimeshouldiwatchnext</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(url)}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(url)}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(title)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(desc)}">`)
    .replace('<main id="app">', `<main id="app">${block}`);
}

/* The "narrow it down" line on a genre page: a link to every combination page
   written under it, biggest first. The pages' only route in besides the
   sitemap, the same job the "More like this" line does for the genre pages. */
function comboLinksFor(combos) {
  if (!combos.length) return '';
  const links = combos
    .map((c) => `<a href="${esc(c.path)}">${esc(c.other)}</a> <span class="genre-combo-count">${c.count}</span>`)
    .join(' · ');
  return `      <p class="genre-combos"><span class="genre-combos-label">Narrow it down:</span> ${links}</p>\n`;
}

function genrePageFor(genre, entries, anchor, combos = []) {
  const url = `${SITE}${genrePathFor(genre)}`;
  const lower = genre.toLowerCase();
  const title = `The best ${lower} anime you can start from the beginning`;
  const desc = `${entries.length} ${lower} anime ranked by MyAnimeList, with none of the `
    + `sequels, side stories or recap editions you cannot start cold. `
    + `Top of the list: ${entries.slice(0, 3).map((e) => e.title).join(', ')}.`;

  const rows = artRowsFor(entries);

  /* A plain link, not a scripted button. It works before app.js has parsed and
     it works with scripting off, where it lands on the home page rather than
     doing nothing. */
  const cta = anchor
    ? `      <p class="genre-cta"><a class="btn" href="/?genre=${esc(slugify(genre))}">Recommend me one ${esc(lower)} anime</a></p>`
    : '';

  const block = `
    <div id="seo-content" class="seo-content genre-page">
      <p class="genre-home"><a href="/">whatanimeshouldiwatchnext</a></p>
      <h1>${esc(title)}</h1>
      <p class="seo-lede">${esc(desc)}</p>
${cta}
${comboLinksFor(combos)}      <h2>The list</h2>
      <ol class="seo-list genre-list genre-list-art">
${rows}
      </ol>
      <p class="seo-note"><strong>Why this is not MyAnimeList's ${esc(lower)} ranking.</strong>
      Every entry here is one you can start from the beginning. Anything with a prequel or a
      parent story is left out, as are recaps and compilation editions — about half of what
      MyAnimeList ranks — so there are no second seasons or side stories to work backwards from.
      Ordered by MyAnimeList position. The percentage is the share of MyAnimeList scorers who
      rated a title 7 or higher.</p>
    </div>`;

  return listingPage(title, desc, url, block);
}

/* ---------- combination pages: /genre/<genre>/<label>/ ----------
 *
 * "best isekai fantasy anime" is a real query and no single genre page answers
 * it. Each of these is a genre crossed with one more label -- a theme, or a
 * second genre -- drawn from the same startable catalogue, in the same artwork
 * rows as the genre pages.
 *
 * **A page must fill the list.** COMBO_MIN is GENRE_SHOWN, so every one of
 * them prints the full 25 a genre page does. Measured on build 67: 194 pairs
 * clear it -- 135 genre + theme, 59 genre + genre -- against 388 at the
 * browse view's floor of 8. Half as many pages, none of them thin. 194 on
 * top of ~4,970 is a 4% change to what a crawler is asked to fetch.
 *
 * **Two genres make one page, not two.** Action + Fantasy lives at
 * /genre/action/fantasy/ and nowhere else, filed under whichever offered genre
 * sorts first, and both genre pages link to it. A genre crossed with a theme
 * is always filed under the genre. */
const COMBO_MIN = GENRE_SHOWN;

/* How a pair reads in a sentence. The label goes in front -- "isekai fantasy",
   "psychological mystery", "school romance" -- which is how people say it and
   how they search for it. A label that already ends in the genre's own word
   stands alone: "team sports", never "team sports sports". */
const PHRASE = {
  CGDCT: 'cute-girls-doing-cute-things',
  'Award Winning': 'award-winning',
  'Idols (Female)': 'female idol',
  'Idols (Male)': 'male idol',
};
const phraseOf = (label) => PHRASE[label] || label.toLowerCase();
function comboPhrase(genre, other) {
  // Award Winning is an adjective, so it leads whichever side it is on.
  if (genre === 'Award Winning') return `${phraseOf(genre)} ${phraseOf(other)}`;
  if (other === 'Award Winning') return `${phraseOf(other)} ${phraseOf(genre)}`;
  const o = phraseOf(other);
  const g = phraseOf(genre);
  return o.endsWith(g) ? o : `${o} ${g}`;
}

const comboPathFor = (genre, other) => `/genre/${slugify(genre)}/${slugify(other)}/`;

function comboPageFor(combo, entries) {
  const { genre, other, count, path, otherPath } = combo;
  const url = `${SITE}${path}`;
  const phrase = comboPhrase(genre, other);
  const title = `The best ${phrase} anime you can start from the beginning`;
  const desc = `${count} anime that are both ${phraseOf(genre)} and ${phraseOf(other)}, ranked by `
    + `MyAnimeList, with none of the sequels, side stories or recap editions you cannot start cold. `
    + `Top of the list: ${entries.slice(0, 3).map((e) => e.title).join(', ')}.`;

  /* Up to both parents: the genre it is filed under, and the other label's own
     page when that is a genre with one. */
  const parents = [`<a href="${esc(genrePathFor(genre))}">${esc(genre)}</a>`];
  if (otherPath) parents.push(`<a href="${esc(otherPath)}">${esc(other)}</a>`);

  /* Into the browse view with both labels picked, which is this same list with
     the format and year filters beside it and a button for a card. A link, so
     it works before app.js has parsed. */
  const browseHref = `/?browse=${slugify(genre)},${slugify(other)}`;

  const block = `
    <div id="seo-content" class="seo-content genre-page">
      <p class="genre-home"><a href="/">whatanimeshouldiwatchnext</a> · ${parents.join(' · ')}</p>
      <h1>${esc(title)}</h1>
      <p class="seo-lede">${esc(desc)}</p>
      <p class="genre-cta"><a class="btn" href="${esc(browseHref)}">Filter these, or get a recommendation</a></p>
      <h2>The list</h2>
      <ol class="seo-list genre-list genre-list-art">
${artRowsFor(entries)}
      </ol>
      <p class="seo-note"><strong>Why this is not a MyAnimeList search.</strong>
      Every entry here is one you can start from the beginning. Anything with a prequel or a
      parent story is left out, as are recaps and compilation editions — about half of what
      MyAnimeList ranks. Ordered by MyAnimeList position. The percentage is the share of
      MyAnimeList scorers who rated a title 7 or higher.</p>
    </div>`;

  return listingPage(title, desc, url, block);
}

/* The index over the fourteen. It exists because the other two doors into the
   genre pages both need somewhere to point: the header button's menu and the
   line under the landing page's chips. Before it, "browse all genres" had no
   honest destination — picking one of the fourteen arbitrarily is not an
   index.

   It is also the page for a query the individual lists cannot answer. "best
   mystery anime" lands on /genre/mystery/; "anime genres" and "what genre of
   anime should i watch" land here.

   Like the genre pages and unlike the anime pages, this block survives app.js
   booting: somebody who arrived here came for the list of genres. */
function genreIndexPageFor(rows) {
  const url = `${SITE}/genre/`;
  const title = 'Anime by genre';
  const desc = `Every genre worth browsing, ${rows.length} of them, each a ranked list of anime `
    + `you can start from the beginning — no sequels, no side stories, no recap editions.`;

  /* Artwork rows, the same treatment as the genre pages themselves — the
     index was the one plain text list left, and it looked it.

     Each genre borrows the banner of a well-ranked show carrying it, and no
     banner is used twice. Without that rule Frieren's art would fill four of
     the fourteen rows, since it tops Fantasy, Adventure, Drama and Award
     Winning. A genre whose shows have all been used falls back to its top
     show's colour, the same fallback the genre pages use. */
  const usedArt = new Set();
  const items = rows.map(({ genre, path, count, top, entries }) => {
    const pick = entries.find((e) => e.banner && !usedArt.has(e.banner)) || null;
    if (pick) usedArt.add(pick.banner);
    const tint = (pick || entries[0])?.colour || '#3a3d42';
    const art = pick
      ? `<img class="genre-art" src="${esc(pick.banner)}" loading="lazy" decoding="async" alt="">`
      : '';
    return `        <li style="--row-tint:${esc(tint)}">
          ${art}
          <span class="genre-row-body genre-index-body">
            <span class="genre-row-text">
              <a href="${esc(path)}"><strong>${esc(genre)}</strong></a>
              <span class="seo-meta">${count} you can start cold</span>
              <span class="genre-alt">${esc(top.join(' · '))}</span>
            </span>
          </span>
        </li>`;
  }).join('\n');

  const block = `
    <div id="seo-content" class="seo-content genre-page">
      <p class="genre-home"><a href="/">whatanimeshouldiwatchnext</a></p>
      <h1>${esc(title)}</h1>
      <p class="seo-lede">${esc(desc)}</p>
      <ol class="seo-list genre-list genre-list-art genre-index">
${items}
      </ol>
      <p class="seo-note"><strong>Why these are not MyAnimeList's genre rankings.</strong>
      Every title on every one of these lists is one you can start from the beginning. Anything
      with a prequel or a parent story is left out, as are recaps and compilation editions —
      about half of what MyAnimeList ranks. Genres too thin to browse are not listed.</p>
    </div>`;

  return listingPage(title, desc, url, block);
}

/* ---------- generate ---------- */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
if (existsSync(GENRE_OUT)) rmSync(GENRE_OUT, { recursive: true, force: true });

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

/* ---------- the genre pages ---------- */

/* Written after the anime pages because they link into them, and because the
   anchor search costs about twenty walks per genre — cheap at fourteen pages,
   which is why this runs once at the end rather than per entry. */
const genreUrls = [];
const indexRows = [];
let genreCount = 0;

/* The combination pages, counted before any genre page is written because
   each genre page links to its own. Ecchi is left out as a second label for
   the reason it is withheld as a chip: a page is a door in by the side route. */
const offeredGenres = w.__seo.genres();
const withheld = new Set(w.__seo.excluded());
const allGenreNames = new Set(all.flatMap((a) => a.genres));
const comboCounts = new Map();
for (const genre of offeredGenres) {
  for (const a of all) {
    if (!a.local || !a.genres.includes(genre)) continue;
    for (const other of [...a.genres, ...a.themes]) {
      if (other === genre || withheld.has(other)) continue;
      // Two offered genres make one page, filed under whichever sorts first.
      if (offeredGenres.includes(other) && other < genre) continue;
      const key = `${genre}|${other}`;
      comboCounts.set(key, (comboCounts.get(key) || 0) + 1);
    }
  }
}
const combos = [...comboCounts]
  .filter(([, count]) => count >= COMBO_MIN)
  .map(([key, count]) => {
    const [genre, other] = key.split('|');
    return {
      genre, other, count,
      path: comboPathFor(genre, other),
      // Only a genre this generator writes a page for gets linked.
      otherPath: offeredGenres.includes(other) ? genrePathFor(other) : null,
      isGenre: allGenreNames.has(other),
    };
  })
  .sort((x, y) => y.count - x.count);

/* What a genre page links to: pairs filed under it, and genre pairs filed
   under the other genre, named by the label that is not this page's own. */
const combosFor = (genre) => combos
  .filter((c) => c.genre === genre || (c.otherPath && c.other === genre))
  .map((c) => ({ ...c, other: c.genre === genre ? c.other : c.genre }));

for (const genre of offeredGenres) {
  const carrying = all.filter((a) => a.local && a.genres.includes(genre));
  const entries = carrying.slice(0, GENRE_SHOWN);
  if (entries.length < 5) continue;      // too thin to be a page worth having

  const anchor = w.__seo.anchorFor(genre);
  const rel = genrePathFor(genre);
  const file = join(ROOT, rel, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, genrePageFor(genre, entries, anchor, combosFor(genre)));
  genreUrls.push(rel);
  /* The whole count rather than the 25 shown, because the index is describing
     how much there is to browse, not how much one page prints. */
  indexRows.push({
    genre, path: rel, count: carrying.length,
    top: entries.slice(0, 3).map((e) => e.title),
    entries,
  });
  genreCount += 1;
}

/* Written after the genre pages, and only under a genre page that was itself
   written, so no combination page ever links up to a 404. */
const comboUrls = [];
for (const combo of combos) {
  if (!genreUrls.includes(genrePathFor(combo.genre))) continue;
  const entries = all
    .filter((a) => a.local && a.genres.includes(combo.genre)
      && (a.genres.includes(combo.other) || a.themes.includes(combo.other)))
    .slice(0, GENRE_SHOWN);
  const file = join(ROOT, combo.path, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, comboPageFor(combo, entries));
  comboUrls.push(combo.path);
}

/* The index over them, written last because it reports what actually got
   written -- a genre skipped for being too thin must not be listed. */
const indexFile = join(GENRE_OUT, 'index.html');
mkdirSync(GENRE_OUT, { recursive: true });
writeFileSync(indexFile, genreIndexPageFor(indexRows));
genreUrls.unshift('/genre/');

/* The "page not found" page. Without a 404.html at the root, Cloudflare Pages
   answers every unknown address with the home page and a 200, which Google
   reports as a soft 404 and which tells a visitor nothing. With one, Pages
   serves it with a real 404 status instead.

   It is index.html rather than a page of its own, so the app still boots on
   it: /anime/<id>/<wrong-slug>/ has no file behind it, and the app routes on
   the id alone, so a mistyped or outdated slug on a real anime still opens
   that anime. A crawler gets the 404; a person gets the show.

   Generated from index.html on every run, like every other page here, so a
   ?v= bump or a markup change can never leave it serving a stale script. No
   canonical and no og:url, since this document has no address of its own. */
const notFoundNotice = `<p id="not-found-notice" class="catalogue-notice not-found-notice"><b>There's no page at that address.</b> The link may be mistyped, or the page has gone. Search for an anime you've watched, or <a href="/genre/">browse by genre</a>.</p>
      <p class="tagline">`;
const notFound = html
  .replace('<html lang="en">', '<html lang="en" data-not-found>')
  .replace(/<title>[^<]*<\/title>/, '<title>Page not found · whatanimeshouldiwatchnext</title>')
  .replace(/\s*<link rel="canonical" href="[^"]*">/, '\n  <meta name="robots" content="noindex">')
  .replace(/\s*<meta property="og:url" content="[^"]*">/, '')
  .replace('<p class="tagline">', notFoundNotice);
for (const marker of ['data-not-found', 'Page not found', 'noindex', 'not-found-notice']) {
  if (!notFound.includes(marker)) throw new Error(`404.html: the ${marker} replacement matched nothing in index.html`);
}
writeFileSync(join(ROOT, '404.html'), notFound);

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
${entry('/', '1.0', 'weekly')}${entry('/privacy', '0.3', 'yearly')}${genreUrls.map((u) => entry(u, '0.8', 'weekly')).join('')}${comboUrls.map((u) => entry(u, '0.7', 'monthly')).join('')}${urls.map((u) => entry(u, '0.6', 'monthly')).join('')}</urlset>
`;
writeFileSync(join(ROOT, 'sitemap.xml'), sitemap);

console.log(`wrote ${written} pages under /anime/`);
console.log(`skipped ${targets.length - written} with nothing to recommend`);
console.log(`wrote ${genreCount} pages under /genre/`);
console.log(`wrote the /genre/ index over ${indexRows.length}`);
console.log("wrote 404.html");
console.log(`wrote ${comboUrls.length} combination pages, at least ${COMBO_MIN} shows each`);
console.log(`sitemap.xml lists ${urls.length + genreUrls.length + comboUrls.length + 2} URLs`);
