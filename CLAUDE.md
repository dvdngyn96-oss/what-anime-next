# whatanimeshouldiwatchnext

Type an anime you've already watched; get the next one **up the MyAnimeList
rankings** that shares its genres. A blank Google-style page, a search box, and
a card.

Static site. No build step, no server, no runtime API calls for the core loop.

---

## Current state

**Build 28.** `anime.json` holds **3,490 entries** (TV 2,641 · ONA 540 · OVA 309),
about 1.15 MB. 109 checks pass via `npm test`.

| Data | Coverage |
| --- | --- |
| Key-art colour | 3,254 |
| Banner image | 2,321 |
| Studio | 3,412 |
| TMDB match | 3,116 |
| US/CA streaming | 1,610 |
| AniList tags | 3,230 (93%) |
| Genres backfilled from AniList (`gs`) | 43 |
| No genres (never recommended) | 31 |

**Live at https://what-anime-next.pages.dev** on Cloudflare Pages, deploying
from `main` on GitHub (`dvdngyn96-oss/what-anime-next`). Every push redeploys
automatically, in about 40 seconds.

**Use the bare hostname.** Each deploy also gets a pinned URL like
`1da78362.what-anime-next.pages.dev`, which serves that build *forever* —
Cloudflare hands you one in the "Deployment URL" line after a build, and it
looks like the site's address. Chasing a stale build number on one of those
wasted a session's worth of confusion once already.

---

## Commands

```bash
npm run serve     # python -m http.server 8777
npm test          # 109 checks, jsdom against the real app.js and anime.json
npm run walks     # prints recommendation chains for 14 known anchors
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
affinity = round(tagSimilarity × 6) + (same demographic ? 2 : 0)
```

where `tagSimilarity` is cosine similarity over AniList's weighted tags, and
entries without tags (8%) fall back to the old `shared themes` count.

**A better match earns a longer jump, measured in ranking positions.** Each
point of affinity buys `AFFINITY_REACH` (30) positions of extra distance over
the nearest candidate; `MAX_LOOKAHEAD` (30) bounds the scan for cost. Sorting a
whole bucket by affinity instead let a distant match leapfrog everything nearer
— walking down from FMA:B, Arslan Senki (1,592 places away) jumped ahead of
Berserk (105 away). That one bug produced three separate symptoms before it was
traced.

**Positions, not bucket slots — this is the whole safety argument.** A bucket
holds only genre-sharing candidates, so ten bucket slots can span 1,500 ranking
places. Build 20 first bounded the jump by bucket index and immediately
reproduced the Arslan Senki bug: Arslan led FMA:B's chain and Berserk fell to a
backtrack. Distance has to be measured in the units proximity actually means.

### AniList tags, and why the score is rounded

MAL gives three flat genres and a couple of themes. AniList gives ~8 usable
community-voted tags with relevance weights — FMA:B is *Alchemy 90%, Military
90%, War 90%, Politics 80%* where MAL offers only "Military". Stored as `tg`,
one integer per tag (`tagIndex × 10 + weight`, weight 5-9), with names in their
own `tagNames` table so a tag refresh can never shift a genre's index.

Similarity is **cosine**, not raw overlap: popular shows carry three or four
times as many tags as obscure ones, so an unnormalised sum ranks by fame.

**The rounding is load-bearing, not cosmetic.** Under the old theme count most
candidates scored 0, so `preferLocally` was nearly a no-op and proximity
survived by stable sort. A continuous score gives everyone a distinct value, so
every window reorders — and monotonicity turns each reorder into a *deferral*,
because putting a distant match first stops the nearer ones advancing. Shipped
unrounded, Steins;Gate lost Evangelion, Shinsekai yori and Serial Experiments
Lain from its chain in one stroke. Rounding restores ties, and ties preserve
proximity.

Scaled by 6 because similarity runs about 0.1-0.6, landing on 1-4 — the range
the theme count occupied, which is what the window and the demographic bonus
were tuned against.

The gain is real: walking down from FMA:B now reaches Berserk (#109) and
Mo Dao Zu Shi (#195), both nearer and closer in kind than the old first result
at #385. Roughly half the known-anchor walk lines changed.

### Genres backfilled from AniList

**An entry with no genres can never be matched** — the walk skips it, so it is
invisible rather than merely unlikely. MAL's genre data thins out badly for
pre-1990 TV and merchandise-driven shows, and 74 entries had none at all.
Hyouge Mono (#704, 39 episodes, well regarded) was among them.

`backfill-genres.mjs` fills those from AniList, and the builder does the same
in its art pass. It **only ever fills where MAL supplied nothing** — it never
overrides MAL — and sets `gs: 1` to record the provenance. 43 filled.

Four AniList "genres" are MAL *themes* — Mahou Shoujo, Mecha, Music,
Psychological — so they go to `th`, not `g`. Putting them in `g` would invent
genre values the bucketing logic has never seen and let "Mecha" alone count as
a full genre match.

That mapping is why **31 entries still have no genres**: their only AniList
genre is one of those four. They are mostly idol franchises and 80s mecha.
Filling them would mean fabricating a genre, so they stay unreachable.

### The card is a constant height on purpose

Clicking "show me another" repeatedly is the main way this gets used, and it
only feels right if the buttons don't move. Seven things used to move them:

- **1,169 entries have no banner image**, so their cards were 150px shorter.
  The strip is now unconditional — filled with a gradient from the show's own
  key-art colour when there's no image. `hero-has-banner` is unconditional too,
  so the poster keeps its overlap and the geometry matches either way.
- **The synopsis arrives after render**, from AniList. `.synopsis` has a fixed
  five-line height, not a minimum, matching the 340-character cap applied
  upstream. Nothing reflows when the fetch lands.

- **The streaming row was absent** for the 374 entries with no TMDB match. It
  now always renders, saying "No listing found" — honest, and the same line
  either way.
- **The Trailer button was injected after the fetch**, shifting every button
  beside it sideways, and was missing entirely on the 11% with no trailer. The
  slot is always rendered, hidden via `.btn-reserved` until there is something
  to play. Hidden rather than removed when the video starts, too.

**The explanatory notes moved below the card.** `matchNote`, the outside-the-
catalogue warning and the axis-fallback warning are all conditional, and above
the card their appearing and disappearing moved the card and every button in
it — worst of the four, because a note shows up exactly when the result changed
in a way worth reading about. Under the card they explain what you were just
shown without ever moving it. A check asserts they never render above `.hero`.

Every conditional block in the card is now unconditional, and the conditional
ones outside it sit below. The "card keeps its shape" checks in
`test/suite.mjs` render a sparse entry and a rich one and assert both produce
the same skeleton — jsdom has no layout, so it guards the structure, which is
enough to catch a conditional render creeping back.

- **The title wrapped** on 14% of desktop cards and 31% of mobile ones. It now
  reserves two lines (three on mobile) and clamps beyond that — 1% of titles,
  the worst being 127 characters. The blank line under a short title reads as
  padding; a button that moves does not.

- **The genre row wrapped** on roughly 10% of desktop cards, and **the badge
  row** (hidden gem, currently airing) appears on about the same. Both now
  reserve their space: two chip rows on desktop, three on mobile, and one badge
  row always rendered even when empty.

The 10% figure understates how often you meet it. Cards cluster by kind, so a
chain of dark psychological shows all carry long genre lists — Texhnolyze has
eight chips against Kubikiri Cycle'''s four, and they turned up within five
clicks of each other. Frequency across the catalogue is the wrong measure;
frequency *along a walk* is what you feel.

**A failed synopsis fetch is never cached.** AniList rate-limits, and clicking
through quickly fires one request per card, so bursts produce failures. Caching
them stored "no synopsis" for the rest of the session, and because the block is
now a reserved five lines, that read as a broken card rather than as nothing.
Failures are left uncached so the next visit retries, the fetch waits 220ms so
a card you skim past costs no request at all, and an empty block says which
kind of empty it is — "Synopsis unavailable just now" against "No synopsis on
record".

The Trailer button sits **last** in the action row. Its slot is always rendered
to hold the row width, and reserved space at the front left a visible hole
before the first button; at the end it falls where the row already runs out.

Chips are clipped rather than capped at a count: a chip can be the shared theme
the note is explaining, and dropping it would remove the reason the result was
chosen.

### The format filter

Three chips — **TV / ONA / OVA** — in a third toggle row, each independently
on or off, defaulting to all on and remembered in `localStorage`.

It exists because ONA is the mixed bag: Cyberpunk: Edgerunners and Takopi's
Original Sin sit alongside a long tail of donghua that crowds the isekai range
around #4000-5000. A single "TV only" switch would have taken OVA with it, and
OVA holds Hellsing Ultimate and FLCL.

**It filters candidates, not anchors.** Whatever you searched for stays usable
as a starting point — refusing the show someone just typed would be baffling.
"Surprise me" does respect it, though, because being handed a donghua straight
after switching ONA off reads as the toggle being broken.

The last format on cannot be switched off; otherwise the card empties itself
with no way back but a reload.

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

**Recaps need their own title rule.** Excluding MAL's `special` media_type is
not enough — plenty of recaps are typed OVA or ONA and sail through. Chainsaw
Man Recap sat at #1207 through four builds. `looksLikeRecap` in
`build-catalogue.mjs` catches *recap, digest, compilation, soushuuhen* and
*special edition/anime/animation* anywhere in either title.

"Special" alone is unusable as a word match: **Special A** is a real 24-episode
TV series and **A Returner's Magic Should Be Special** a real 12-episode one.
It only signals a recap as a *trailing* word, and only on OVA/ONA. The single
TV compilation, Gundam IBO Tokubetsu-hen, is caught by "Special Edition" in its
English title instead. Build 19 pruned 23 entries this way.

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
| `node add-anilist-tags.mjs` | rarely — tags drift slowly | ~3 min |
| `node backfill-genres.mjs` | after a rebuild only if it reports blanks | ~10 s |

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

Streaming is the *only* follow-up. AniList tags and genre backfill both happen
inside the builder's art pass, so a rebuild carries them already —
`add-anilist-tags.mjs` and `backfill-genres.mjs` exist for fixing an existing
catalogue without paying the 60 minutes.

**Long builds must run detached**, or a Claude Code crash takes them with it:

```bash
powershell -c "Start-Process node -ArgumentList 'build-catalogue.mjs','--depth','8000' -WorkingDirectory 'C:\Users\David\Downloads\what-anime-next' -RedirectStandardOutput 'rebuild.log' -WindowStyle Hidden"
```

The builder only writes at the very end, so an interrupted run loses progress
but never corrupts the existing catalogue.

---

## Open

**The voting system.** "Have you watched it" → "would you recommend it", a
% recommend rating, and MAL XML list import. The only part of the original idea
still missing, and the only part needing a backend. Roughly 177,000 votes would
be needed for meaningful per-title percentages, which is why list import
matters — a few hundred uploads does what millions of pageviews would.

~~**Tune `AFFINITY_REACH` against real taste.**~~ Judged good as shipped —
30 positions per affinity point, 2026-08-19, by reading the live chains rather
than the test output. There is no ground truth here, so that verdict *is* the
evidence. Don't re-tune it without a reason and a fresh read of the walks;
60 was the other defensible value if one is ever wanted.

**31 entries still have no genres** and so can never be recommended. Their only
AniList genre is Mahou Shoujo, Mecha, Music or Psychological — MAL themes, not
genres. Filling them means either fabricating a genre or teaching the matcher
to bucket on themes. Mostly idol franchises and 80s mecha, so low stakes.

**Small phones remain unverified below 390px.** Build 17's reorder means the
title no longer depends on a tall viewport, but no SE or Mini has actually
loaded the site.

---

## Settled

Kept short; the reasoning that still matters has moved into the sections above.

- **Deployment** — live on Cloudflare Pages, auto-deploying from `main`.
  Build settings: preset **None**, build command **empty**, output `/`. The
  build command matters — Cloudflare's Workers import flow prefills
  `npm run build`, which here is the 60-minute catalogue rebuild.
  Cloudflare serves the whole repo root, so `package.json`, the `.mjs` scripts
  and `test/` are publicly fetchable; no secrets in them. `/.mal-client-id`
  returns `index.html` (the SPA fallback), not the file — it is not in the repo.
- **AniList tags** — landed build 19, affinity only. Needed no second harvest.
- **Genre backfill** — 43 of 74 recovered from AniList.
- **Recaps** — 23 dropped; `looksLikeRecap` keeps them out of future builds.
- **43 unverified entries** — settled by the build-16 rebuild, now 0. That
  rebuild also dropped 24 entries whose relation lookups had failed open.
- **Small phone** — the guess was wrong: the toggles were fine, the key art was
  the problem. Fixed in build 17 by lifting the identity block above the art.
- **Desktop after the mobile rework** — checked at build 19 and unchanged:
  poster overlapping the banner, identity block beside it, actions in one row,
  three-column grid. `display: contents` stays inside the ≤620px breakpoint.

---

## Working notes

- Verify against data rather than assuming. Several "obvious" fixes in this
  project made things measurably worse and were reverted — check known-good
  walks (`npm run walks`) *before* declaring a change good, not after.
- **Capture a walks baseline before touching the matcher, and diff.** For a
  change meant to preserve behaviour, byte-identical output is the proof. For a
  change meant to improve it, the diff is the only evidence there is — read it
  anchor by anchor. The tags work looked finished and was silently dropping
  Steins;Gate's three nearest matches; only the diff showed it.
- **Dry-run any rule that deletes entries.** The recap patterns matched two
  real series (Special A, A Returner's Magic Should Be Special) on the first
  draft. A report-only mode costs nothing and caught it.
- **Write-then-rename when a long job checkpoints.** A plain `writeFileSync`
  onto `anime.json` died mid-run with UNKNOWN (errno -4094) — Windows had it
  briefly locked. Renaming a temp file over it is atomic.
- The user finds real bugs by clicking through the live site. Screenshots have
  caught things the test suite structurally could not.
- `positionOf()` returns `rankPos` or `completionPos` depending on the active
  axis. Anything touching ordering must go through it, not `anime.rank`.
- Three things a change here can quietly break, in the order they bite:
  match quality, then direction, then monotonicity. A reorder that looks local
  becomes a *deletion* through the monotonicity rule, because a candidate that
  no longer advances gets deferred out of sight.
