/* GET /api/mal-list?user=<name>&offset=<n>
 *
 * Reads somebody's public MyAnimeList list so they can type a username instead
 * of finding the export page, downloading a .xml.gz and locating the file.
 * That download is the highest-friction step in the whole site and most people
 * abandon it.
 *
 * **This exists only because the credential cannot go in the browser.**
 * MyAnimeList will serve a public list to anyone holding a client id — no
 * OAuth, no user token — but that id is a build-time secret, gitignored, and
 * putting it in `app.js` would publish it to every visitor. So the request is
 * made here, where `env.MAL_CLIENT_ID` stays server-side. The Function adds
 * nothing else: it forwards a username and slims the answer.
 *
 * **One page per request, and the client loops.** The free tier allows 10ms of
 * CPU per request, and `JSON.parse` on a few megabytes of list data would not
 * fit — a large list runs to thousands of entries and MyAnimeList returns the
 * full node for each whatever `fields` asks for. Paging keeps each call small
 * and lets the page report progress, exactly as the ratings upload already
 * chunks at 100 for the same reason.
 *
 * Returns { entries: [[id, status, score], ...], next: <offset|null> }.
 * Compact arrays rather than objects: a 5,000-title list is sent as three
 * numbers per row instead of three keys and three numbers.
 */
import { json, bad } from './_shared.js';

/** Entries per upstream request. Comfortably inside the CPU budget while
 *  keeping the number of round trips low for a big list. */
const PAGE = 500;

/** Stop rather than following paging forever. 40 pages is 20,000 titles, far
 *  past any real list, and bounds what one username can cost us. */
const MAX_PAGES = 40;

/** MyAnimeList usernames are 2-16 characters of letters, digits, underscore
 *  and hyphen. Checked here so a malformed name never reaches the upstream
 *  request, and so nothing can be smuggled into the URL path. */
const USERNAME = /^[A-Za-z0-9_-]{2,16}$/;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const user = (url.searchParams.get('user') || '').trim();
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) | 0);

  if (!user) return bad('Give a MyAnimeList username.');
  if (!USERNAME.test(user)) {
    return bad('That does not look like a MyAnimeList username.');
  }
  if (offset > PAGE * MAX_PAGES) return bad('That list is longer than we will read.');

  /* No credential configured: say so and let the page fall back to the file
   * importer, which needs no server at all. Same rule as a missing votes
   * database — the site worked without this yesterday and must keep working
   * without it today. */
  if (!env.MAL_CLIENT_ID) return json({ entries: [], next: null, unavailable: true });

  const upstream = `https://api.myanimelist.net/v2/users/${encodeURIComponent(user)}`
    + `/animelist?fields=list_status&limit=${PAGE}&offset=${offset}&nsfw=true`;

  let res;
  try {
    res = await fetch(upstream, { headers: { 'X-MAL-CLIENT-ID': env.MAL_CLIENT_ID } });
  } catch {
    return json({ error: 'MyAnimeList could not be reached just now.' }, 502);
  }

  /* The two failures worth telling apart, because the remedy is completely
   * different and "not found" for a private list would send somebody hunting
   * for a typo that is not there. */
  if (res.status === 404) {
    return json({ error: `No MyAnimeList user called "${user}".` }, 404);
  }
  if (res.status === 403 || res.status === 401) {
    return json({
      error: `${user}'s anime list is private, so it cannot be read.`
        + ' Make it public in your MyAnimeList settings, or use the file import.',
    }, 403);
  }
  if (!res.ok) {
    return json({ error: `MyAnimeList returned ${res.status}.` }, 502);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return json({ error: 'MyAnimeList sent something unreadable.' }, 502);
  }

  const rows = Array.isArray(body?.data) ? body.data : [];
  const entries = [];
  for (const row of rows) {
    const id = row?.node?.id;
    if (!Number.isInteger(id) || id <= 0) continue;
    const st = row?.list_status?.status;
    const score = row?.list_status?.score;
    entries.push([id, typeof st === 'string' ? st : '', Number.isInteger(score) ? score : 0]);
  }

  // `paging.next` is a full URL; the client only needs to know where to resume.
  const next = body?.paging?.next && rows.length ? offset + rows.length : null;

  return json({ entries, next });
}

/* Pages routes a method only if a handler is exported for it, so without this a
 * HEAD falls through to the static handler and answers with the SPA's
 * index.html — HTML, from a JSON endpoint. Same fix as ratings.js, and
 * deliberately a second named handler rather than a catch-all `onRequest`:
 * exporting both leaves it ambiguous which Pages prefers.
 *
 * A HEAD with no `user` fails validation before any upstream call, so
 * monitoring this endpoint costs no MyAnimeList quota. */
export async function onRequestHead(context) {
  const response = await onRequestGet(context);
  return new Response(null, { status: response.status, headers: response.headers });
}
