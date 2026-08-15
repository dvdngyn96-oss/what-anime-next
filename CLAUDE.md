# whatanimeshouldiwatchnext

Type an anime you've already watched; get the next one **up the MyAnimeList
rankings** that shares its genres. A blank Google-style page, a search box, and
a card.

Static site. No build step, no server, no runtime API calls for the core loop.

---

## Current state

**Build 16.** `anime.json` holds **3,513 entries** (TV 2,642 · ONA 550 · OVA 321),
about 1 MB. 89 checks pass via `npm test`.

| Data | Coverage |
| --- | --- |
| Key-art colour | 3,261 |
| Banner image | 2,324 |
| Studio | 3,435 |
| TMDB match | 3,118 |
| US/CA streaming | 1,610 |
| No genres (never recommended) | 77 |

Never deployed — localhost only.

---

## Commands

```bash
npm run serve     # python -m http.server 8777
npm test          # 89 checks, jsdom against the real app.js and anime.json
npm run walks     # prints recommendation chains for known anchors
npm run build     # full catalogue rebuild, ~60 min
```

Two credential files, both gitignored, both **build-time only** — nothing ships
in the browser:

- `.mal-client-id` — MyAnimeList API, registered **non-commercial**
- `.tmdb-key` — TMDB v3, registered **personal use**

Monetising later means revisiting both registrations. TMDB's definition of
commercial is broader than "makes money"; deploying isn't the trigger, ads are.

### After changing app.js or styles.css

Bump `BUILD` in `app.js` **and** the `?v=` markers in `index.html` together.
The build number renders in the footer. A stale cached script caused more
confusion in this project than any real bug — if a result looks wrong, check
the footer before investigating.

---

## How the recommendation works

The whole catalogue is on the client, so the walk is literal rather than
approximate: find your anime's row, step one position at a time toward rank #1,
return entries sharing its genres.

**Three things compete, and they rank in this order:**

1. **Match quality** — a full genre match below beats a weak one above. This is
   why Steins;Gate (#5) reaches Evangelion rather than Fullmetal Alchemist on
   the strength of "Drama" alone.
2. **Direction** — within a quality tier, exhaust everything higher before
   turning around. The Saint's Magic Power has 35 matches above it; pooling the
   leftovers globally once buried 9 of them behind 120 downward results.
3. **Monotonicity** — climb steadily; defer anything out of order.

This ordering was broken twice by changes that satisfied two of the three. The
implementation keeps each pass's clean run and its deferred entries together,
which is what makes all three hold at once. `walkRankings` in `app.js`.

### Genres decide, demographic and themes break ties

MAL merges genres, themes and demographics into one field; the builder splits
them. Matching happens on **genres**. Ordering then uses:

```
affinity = shared themes + (same demographic ? 2 : 0)
```

**Affinity only reorders within `AFFINITY_WINDOW` (5) neighbours.** Sorting a
whole bucket by affinity let a distant match leapfrog everything nearer —
walking down from FMA:B, Arslan Senki (1,592 places away) jumped ahead of
Berserk (105 away). That one bug produced three separate symptoms before it was
traced.

### Kids is demoted

`Kids` is the one demographic marking a different *audience* rather than a
different tone. Without demoting it, a 12-episode dark isekai recommends
Pokémon — 276 episodes, same three genres, 48 places away. Affected 54 anchors.

### Two ranking axes

**MAL rank** (default) and **Kept watching** (raw completion). Completion
correlates only 0.35 with MAL rank, so it measures something genuinely
different — but it skews short, and it *penalises episodic shows*: Mushishi is
MAL #87 and sits below a slice-of-life source on that axis. That's why MAL rank
is the default rather than the two being presented as equals.

The length-adjusted **residual** (the ±N on the card) is good for judging one
show but a poor *ranking* axis — par sits so low at the long end that franchise
serials float to the top. Ranking uses the raw figure deliberately.

### The walk climbs `rankPos`, not `rank`

**MyAnimeList gives the same rank to different titles** — 64 collisions inside
the top 8,000, confirmed in a single snapshot. Uniqueness is not ours to
enforce, and no rebuild will produce a tie-free catalogue.

So `positionOf()` returns `rankPos`, a 1-based ordinal over the rank-sorted
catalogue, mirroring `completionPos`. `rank` stays MAL's number and is what the
card shows. `renumberRanked()` rebuilds the ordinal, and `insertByScore()` must
call it after splicing a live AniList find in, or every position below the
insert is stale.

Build 16 made this change; every walk in `npm run walks` came out
byte-identical, so it is behaviour-preserving on the known anchors.

A tie looks like a sort bug when the test fails. It isn't — check for *equal*
ranks, not inverted ones. A strictly-decreasing check finds nothing.

---

## Catalogue rules

Only things you can start watching cold:

- **TV, OVA and ONA.** No films, specials or recaps.
- **No prequel, no parent story.** Anything with either is dropped.

`STANDS_ALONE_ANYWAY` in `build-catalogue.mjs` is a hand-curated allowlist,
**deliberately not a heuristic**. MAL's relation data cannot separate Hellsing
Ultimate (a retelling) from Hunter x Hunter: Greed Island (a continuation) —
both list a prequel and an alternative version. Three rules were tried and all
three failed. Current entries: Hellsing Ultimate, Legend of the Galactic
Heroes, Pluto, Steel Ball Run.

Each build prints well-regarded OVAs/ONAs it dropped, formatted as ready-to-paste
IDs. That list is a judgement call for the human, not something to automate.

To add one without a 60-minute rebuild: add the ID, then
`node add-one.mjs <mal-id>`.

---

## Maintenance

| Task | Cadence | Time |
| --- | --- | --- |
| `npm run build` | once a season | ~60 min |
| `node add-watch-providers.mjs` | whenever listings feel stale | ~20 min |

They're separate on purpose: TMDB ids never change, but streaming availability
moves constantly, so refreshing listings shouldn't cost another hour of
relation checks.

**A rebuild is a two-step job.** `build-catalogue.mjs` writes a fresh catalogue
with **no `tm` and no `wp` fields at all** — it has no provider data to carry
forward. Straight after `npm run build`, run `node add-watch-providers.mjs` or
the site ships with zero streaming listings. The catalogue is not
release-ready between the two, and they must never run concurrently: both
rewrite `anime.json` in place, and the providers pass holds the whole catalogue
in memory, so it will overwrite anything edited while it runs.

**Long builds must run detached**, or a Claude Code crash takes them with it:

```bash
powershell -c "Start-Process node -ArgumentList 'build-catalogue.mjs','--depth','8000' -WorkingDirectory 'C:\Users\David\Downloads\what-anime-next' -RedirectStandardOutput 'rebuild.log' -WindowStyle Hidden"
```

The builder only writes at the very end, so an interrupted run loses progress
but never corrupts the existing catalogue.

---

## Open

**Deployment.** Still localhost. Six static files to Cloudflare Pages.
**Push via Git, not drag-and-drop** — `.gitignore` protects both API keys, but
only if Git is the mechanism carrying the files.

**AniList tags.** The largest available upgrade to recommendation quality:
*Exorcism 79%*, *Reincarnation 70%* with relevance weights, against MAL's three
flat genres. Needs a second harvest and a matcher rework.

**The voting system.** "Have you watched it" → "would you recommend it", a
% recommend rating, and MAL XML list import. The only part of the original idea
still missing, and the only part needing a backend. Roughly 177,000 votes would
be needed for meaningful per-title percentages, which is why list import
matters — a few hundred uploads does what millions of pageviews would.

~~**43 entries kept unverified.**~~ Settled by the build-16 rebuild: the
four-times retry worked and the count is **0**. That rebuild also dropped 24
entries whose relation lookups had previously failed open and which do in fact
have a prequel.

**Never seen on a small phone.** XR and Pro Max are fine; an SE or Mini would
likely push the card below the fold given the toggles.

---

## Working notes

- Verify against data rather than assuming. Several "obvious" fixes in this
  project made things measurably worse and were reverted — check known-good
  walks (`npm run walks`) *before* declaring a change good, not after.
- The user finds real bugs by clicking through the live site. Screenshots have
  caught things the test suite structurally could not.
- `positionOf()` returns rank or completion position depending on the active
  axis. Anything touching ordering must go through it, not `anime.rank`.
