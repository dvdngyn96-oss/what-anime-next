# whatanimeshouldiwatchnext

Type an anime you've already watched; get the next one **up the MyAnimeList
rankings** that shares its genres. A blank Google-style page, a search box, and
a card.

Static site. No build step, no server, no runtime API calls for the core loop.

---

## Current state

**Build 34.** `anime.json` holds **3,505 entries** (TV 2,680 · ONA 533 · OVA 292),
about 1.18 MB. 169 checks pass via `npm test`.

| Data | Coverage |
| --- | --- |
| Key-art colour | 3,274 |
| Banner image | 2,358 |
| Studio | 3,388 |
| TMDB match | 3,152 |
| US/CA streaming | 1,642 |
| AniList tags | 3,252 (93%) |
| Genres backfilled from AniList (`gs`) | 42 |
| No genres (matched on themes only) | 31 |

**Live at https://whatanimeshouldiwatchnext.com** on Cloudflare Pages, deploying
from `main` on GitHub (`dvdngyn96-oss/what-anime-next`). Every push redeploys
automatically, in about 40 seconds.

`what-anime-next.pages.dev` still serves the same site and is still where
Pages deploys land; the apex is the canonical address and is what every
absolute URL in the repo points at.

**Use the bare hostname.** Each deploy also gets a pinned URL like
`1da78362.what-anime-next.pages.dev`, which serves that build *forever* —
Cloudflare hands you one in the "Deployment URL" line after a build, and it
looks like the site's address. Chasing a stale build number on one of those
wasted a session's worth of confusion once already.

---

## Commands

```bash
npm run serve     # python -m http.server 8777
npm test          # 167 checks, jsdom against the real app.js and anime.json
npm run walks     # prints recommendation chains for 19 known anchors
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

### A rare theme is worth a genre

Genres are too broad to identify anything. Comedy is 1,276 shows, Fantasy 968 —
"shares Fantasy" says almost nothing. The identifying word is usually filed as
a *theme*, and themes only broke ties: Isekai is 161 shows and says a great
deal, but it could never decide a match.

**The damage was not that themes ranked too low. It was monotonicity.** Konosuba
is the case. Its genres are Adventure, Comedy and Fantasy, and walking up,
exactly *one* thing shares all three — Dungeon Meshi, 163 places away. Match
quality goes first, so the walk serves it; Dungeon Meshi sits near the top, so
the high-water mark jumps to position 34. The 2-of-3 tier then runs, holding 32
entries including three isekai — and the nearest, 24 places away, cannot beat
position 34, so every one of them is deferred out of sight. Seven results, not
one an isekai, exactly as reported.

This is why **reweighting the themes into `affinity` cannot fix it**, and that
is worth stating because it is the obvious fix. Affinity reorders a bucket.
Which candidates survive a pass is decided by the frontier, not by their order
within it — every ordering of that 2-of-3 tier still leaves all of it behind
position 34. A strong theme match has to enter the *top* tier to be reachable
at all.

So it does. A shared theme carried by **no more than 5% of the catalogue** is
worth one genre for bucketing. `promoteSignatures` in `app.js`, run after the
scan and before `preferLocally`.

**A share, not a count.** 5% of 3,505 entries is 175 shows: Isekai (161),
Military (148), Harem (144), Psychological (132), Space (114), Time Travel (50)
and rarer count; Martial Arts (207), Adult Cast (255), Mecha (270), Historical
(403) and School (658) stay tie-breakers. A fixed count of 200 looks identical
on this catalogue and is a trap — in a six-entry test fixture every theme is
under 200, so everything became a signature theme and five checks failed at
once. Rarity only means something relative to the corpus. Counted at load, so a
rebuild cannot leave it stale.

**Bounded by distance, and that bound is the whole safety argument.** The first
version was unbounded and re-created the Arslan Senki bug this file warns about
twice. Berserk has five genres, so exactly one entry shares them all — and
unbounded promotion let Arslan Senki (528 places away) and Grancrest Senki
(1,376) into that tier. The walk took them first, raced the frontier to the far
end of the rankings, and monotonicity deleted the dense tier of near
neighbours below. The same bug, produced by its own fix.

Two rules keep it honest, and `npm test` fails if either is removed:

- **A candidate may only join the tier above if it is no further from the
  source than that tier's nearest existing member.** Promotion can densify a
  sparse tier; it can never make one reach further.
- **An empty tier is never created.** With no natural member there is nothing
  to measure reach against, and a lone promoted entry ahead of a dense tier is
  the failure above. About one source in eleven is shaped this way.

The rule therefore fires only where the problem is — a top tier that is sparse
*and* distant, 7.2% of anchors — and is a no-op where it is already dense and
close. It only ever promotes, never demotes; it needs at least one genre
already shared, so it invents no new matches and leaves the genre-less tier in
`buckets[0]` alone; and it moves one tier, never two.

**The tier and the shared-genre count are no longer the same number.**
`matchGenres` carries the true count and is what the card's note reports, or it
would tell someone a show shares three genres when it shares two and an Isekai
tag.

Measured over the 17 known anchors: backtracks fell from 26 to 18. Konosuba
opens on two isekai. Cowboy Bebop's six backtracks became a clean run of Space
shows — Planetes, Kanata no Astra, Outlaw Star, Captain Herlock. Steins;Gate
keeps its whole documented chain and gains four nearer matches ahead of it,
one of them Link Click, 15 places away, sharing Time Travel.

**A better match earns a longer jump, measured in ranking positions.** Each
point of affinity buys extra distance over the nearest candidate;
`MAX_LOOKAHEAD` (30) bounds the scan for cost.

**How much distance depends on where the anchor sits, and that is build 34.**
It was a flat 30 positions, which is a small step at #5 and nothing at all at
#1508 — so GATE: Jieitai, whose isekai and military matches sit about 195
places away, recommended Slayers instead. The budget now runs from
`AFFINITY_REACH` (30) up to `REACH_CAP` (60), at `REACH_FRACTION` (0.30) of the
anchor's own position.

**Measuring distance as a ratio instead is the obvious fix and it is wrong.**
Tried first, because #393 to #5 and #1508 to #968 are both "about 150
positions" while being wildly different in kind. It fixes GATE and breaks the
other end: Fullmetal Alchemist: Brotherhood began recommending Arslan Senki
(#1594), Grancrest Senki (#3559) and an entry at #7831. A flat measure
under-reaches deep in the catalogue and a ratio over-reaches there — both are
wrong, in opposite directions, which is why the answer is a position measure
with a moving budget rather than a different measure.

60 is the mildest cap that works. At 50 GATE still leads with Slayers; at 60 it
leads with Drifters, which shares Isekai *and* Military. Of the 19 known
anchors 12 came out byte-identical, including every fragile one — FMA:B,
Steins;Gate, Berserk, Cowboy Bebop, Re:Zero, Konosuba, Mushoku Tensei,
Chihayafuru, Haikyuu, Mushishi, Gakkougurashi, Tokyo Ravens. Backtracks went
from 18 to 22. The one real loss is Toradora, which drops Chihayafuru and
Kodomo no Omocha; Sasaki to Pii-chan and Ame to Kimi to both improved. Sorting a
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
overrides MAL — and sets `gs: 1` to record the provenance. 42 filled.

Four AniList "genres" are MAL *themes* — Mahou Shoujo, Mecha, Music,
Psychological — so they go to `th`, not `g`. Putting them in `g` would invent
genre values the bucketing logic has never seen and let "Mecha" alone count as
a full genre match.

That mapping is why **31 entries still have no genres**: their only AniList
genre is one of those four. They are mostly idol franchises and 80s mecha.

### Genre-less entries match on themes, last

An entry with no genres can never share one, so those 31 were unreachable.
Rather than fabricate a genre for them, build 29 lets them match on a shared
**theme** instead — placed in `buckets[0]`, below every genre match in both
directions, so they surface only once real matches are exhausted.

Scoped to entries with *no* genres. Something that has genres and shares none
of yours is a miss, not a fallback; giving it a second route would change
matching for the whole catalogue rather than for 31 entries.

28 of the 31 have a theme and are now reachable. The remaining three — Psychic
Hero, Enter The Garden, Porte — have neither genre nor theme nor tag, and
nothing short of inventing data will reach them.

`matchNote` special-cases this tier: "widened to 0 of 3 genres (0%)" is true
and useless, so it says the entry has no genres on record and names the theme
that brought it in.

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
three failed.

**Thirteen were added at once in build 32, and they all share one shape.** A
popular series gets a prequel special or film *years later*, MAL records it as
a prequel, and the strict rule concludes you cannot start there. Re:Zero — MAL
rank 393 — was dropped over *Hyouketsu no Kizuna*, a 2019 special, three years
after it aired. Jujutsu Kaisen (#169) was dropped over *JJK 0*, a film made
after the series. Your Lie in April (#91) over its own recap.

They were found by scanning MAL's top 500 TV for entries missing from the
catalogue whose *only* prequel is titled as their own side story — that is, the
prequel's title starts with the show's. That scan is a **candidate generator,
not a rule**: it also flagged Mushoku Tensei II, which really does need season
one, so every entry still gets looked at by a human. Re-run it after a rebuild
if the catalogue feels like it is missing something obvious.

**The sweep went to rank 2,000 next, and found 29 more** — Macross, Digimon
Adventure, Saint Seiya, Slayers, Gundam: Suisei no Majo, Another, Guilty Crown
among them. Suisei no Majo is the *Pluto* case rather than the Re:Zero one: its
disqualifier is `parent_story: Kidou Senshi Gundam`, because MAL files every
Gundam under the 1979 original.

**Six were flagged and rejected, and four of those are the lesson.** Hayate no
Gotoku!!, Genshiken Nidaime, Gatchaman Crowds Insight and High School DxD Hero
are all sequels — and MAL does *not* list their earlier seasons as prequels, so
nothing in the relation data gives them away. Only knowing that `!!`,
*Nidaime*, *Insight* and *Hero* mean seasons two, two, two and four catches
them. That is the argument for this list staying hand-checked, restated with
better evidence than the Hellsing example.

**Adding entries this far down leaves `npm run walks` byte-identical**, because
all fourteen known anchors are top-ranked and never reach rank 955+. The walks
diff proves nothing here, so reachability was checked directly instead: for each
new entry, walk up from anchors just below it and confirm it appears. 29 of 29
did. Do that rather than trusting an unchanged diff.

**`full_story` is a third disqualifying relation, and it means the opposite of
what it sounds like.** It points *away* from an entry at the complete work, so
carrying it is MyAnimeList saying outright that this entry is a condensed
version of something else. 22 entries had it — Ghost in the Shell: SAC – The
Laughing Man, Sailor Moon Memorial, the Haikyuu!! Tokushuu recap — and not one
of them had a prequel or a parent story, so nothing else could see them.

**Do not also use `summary`, which points the other way.** It names the
condensation *of* this entry, so carrying it marks the full work. Ie Naki Ko
Remy, Lodoss-tou Senki: Eiyuu Kishi Den, SAO Alternative: Gun Gale Online and
The iDOLM@STER Cinderella Girls all carry it and are all real series. Treating
the two relations as equivalent would have deleted them; a check now asserts
they are still here.

**`RE_CUTS_AND_EXTRAS` is a hand-curated denylist** — the mirror of
`STANDS_ALONE_ANYWAY`, and hand-curated for the same reason. One Piece: Gyojin
Tou-hen is "One Piece Log: Fish-Man Island Saga", a 2024 re-broadcast
condensing the Fish-Man Island arc into 21 episodes, and MAL files it as
`alternative_version` — the same relation Trigun Stampede and the 2023 Rurouni
Kenshin carry, and those two are real standalone remakes that belong. Nothing
in the relation data separates them. Five entries: the One Piece re-broadcast,
Your Lie in April: Moments, a Steins;Gate IBM Watson promo, the Nichijou pilot
and a Gintama mobile-game collaboration.

**A title pattern is not the answer, and that was checked rather than assumed.**
`-hen` merely means "arc" and appears in Rurouni Kenshin: Tsuioku-hen, #72 and
one of the best-regarded OVAs here; "Saga" appears in Youjo Senki, Zombieland
Saga and Excel Saga. Both patterns would have taken real series with them —
the Special A mistake again.

**This was found by clicking through the live site**, not by the suite: an
Overlord chain reached the One Piece re-broadcast at its sixteenth result.
27 entries removed in total. `npm run walks` came out **byte-identical**, which
proves nothing — none of the seventeen anchors reached any of them — so it was
verified directly instead, by walking from Overlord and confirming the entry is
gone. Same reasoning as adding entries below rank 955.

Each build prints well-regarded OVAs/ONAs it dropped, formatted as ready-to-paste
IDs. That list is a judgement call for the human, not something to automate.

To add one without a 60-minute rebuild: add the ID, then
`node add-one.mjs <mal-id>`.

---

## Shipped behaviour

### Link previews, crawlers and the preview image

`index.html` carries Open Graph and Twitter card tags, and they are
**deliberately static**. Every `/?id=N` URL serves the same document — the card
is built by `app.js` after the catalogue loads — so a scraper never sees a
per-anime title however specific the shared link was. Describing the site is
honest; templating a title nothing fills in is not.

Two mistakes here fail *silently*, which is why `npm test` asserts against them
rather than trusting a reading of the file:

- **A relative `og:image` yields no preview at all.** It resolves against the
  scraper's own host, so it 404s somewhere you never see. Absolute URL, always.
- **`og:image:width` / `:height` drifting from the actual file.** The checks
  read the real dimensions out of the PNG's IHDR chunk (bytes 16 and 20) and
  compare, so regenerating the image at another size fails the suite instead of
  shipping a mis-declared one.

`og.png` is 1200×630 — the 1.91:1 both scrapers want — and is generated by
**`make-og-image.html`**, which draws it on a canvas. There is no `sharp`, no
`canvas` package and no headless browser here, and X/Twitter will not render an
SVG `og:image`, so it had to become a real PNG somehow. Drawing it in a browser
adds no dependency and keeps the image *reproducible*: that file is the source,
so a palette change regenerates it rather than orphaning a mystery binary. Its
colours are copied from `styles.css` by hand — if the palette moves there, move
it there too.

**The background is a horizontal wash for compression reasons, not visual ones.**
The first version used a radial corner glow and came to 368 KB, which is absurd
for flat artwork. PNG predicts each pixel from its neighbours: a ramp along x
makes every row identical to the one above, and the Up filter flattens it to
zeros. A radial gradient is predicted by nothing, so all 756,000 pixels cost
bytes. Measured on this artwork:

| Background | Size |
| --- | --- |
| Radial glow | 364 KB |
| Diagonal ramp | 149 KB |
| Horizontal ramp | 89 KB |
| Flat white | 85 KB |

The tint costs 4 KB. The radial one cost 279.

**And it is painted a column at a time rather than with
`createLinearGradient`.** Canvas gradients are *dithered* — the browser scatters
per-pixel noise to hide banding — and that noise is exactly what defeats the row
predictor. Swapping the radial for a native linear gradient made the file
*bigger*, 364 KB to 407. Only exact integer columns give a ramp the filter can
flatten. Final size is 87 KB.

Don't reach for a radial glow, a soft shadow, or a blur here without measuring
first; all three are the same mistake.

**`robots.txt` does not block `app.js`, `styles.css` or `anime.json`.** Blocking
them would leave a crawler rendering an empty shell and judging the site on it,
which is worse than not being crawled. It does block the build scripts, the
test directory and `make-og-image.html` — Cloudflare serves the whole repo root,
so those are all publicly fetchable. They hold no secrets, but they are source,
not content.

**`sitemap.xml` lists one URL.** There are 3,505 results, but all of them serve
byte-identical HTML, so listing them would hand a crawler thousands of URLs with
the same markup — which is what duplicate content means. The root is the only
distinct document the site has.

### The watched list

Shows you have already seen, so they stop being recommended. This is **stage
one of the voting system**, and the only stage that needs no server at all.

It lives in your browser's local storage under `wanx:watched:v1` and nowhere
else. No account, no sign-up, no upload. A MyAnimeList export is read on your
own machine; the file never leaves it.

The honest cost of that: the list does not follow you to another device, and
clearing your browsing data clears it. Both are the price of not holding
anyone's data, and worth paying — accounts would mean storing other people's
email addresses and passwords, which is a legal and security responsibility
this project has no reason to take on.

**It filters candidates, not anchors** — the same rule as the format filter.
Searching something you have watched is *the normal way to use this site*: "I
watched this, what next". Refusing the show someone just typed would break the
one thing it is for.

**"Seen it too — drop it" is now permanent.** It used to last only for the
current chain, so a fresh search brought the show back. The button says you
have seen it, so it is taken at its word. "Show me another" is still there for
"not this one" — the two intents were always separate controls, and only one of
them was ever about having watched something.

**Plan-to-watch is deliberately excluded on import.** It is usually the largest
section of a MyAnimeList export, and you have not seen any of it — treating it
as watched would hide exactly the shows someone most wants recommended.
Completed, Watching, On-Hold and Dropped all count as seen.

MyAnimeList hands you a **`.xml.gz`**, so the importer sniffs the first two
bytes for the gzip marker (`1f 8b`) rather than trusting the file name, and
unzips it in the browser with `DecompressionStream`. A plain `.xml` works too.

**An emptied walk has to say which filter emptied it.** If the watched list
removed every candidate, the old message — "nothing shares these genres" — is
false, and reads as the matcher being broken. `watchedSkipped` counts what the
list removed so the message can name the real reason and point at Clear.

### When anime.json does not load

Everything on the page waits on one promise. Before build 31, a failed
catalogue fetch was **silent**: the landing page rendered perfectly — wordmark,
search box, both buttons — and then ignored everything you typed. "Surprise me"
sat on its spinner forever. Only a shared `/?id=N` link reported anything, and
only because `routeFromUrl` happened to have a try/catch.

Worse, `cataloguePromise` memoised the *rejection*, so a single dropped request
kept the session broken until a reload. That is the same mistake as caching a
failed synopsis fetch, one level up where it costs the whole page rather than
five lines of it. The memo now clears itself on failure, which is what makes
**Try again** possible at all.

Three failure shapes, and they read differently on purpose:

| What happened | What it says |
| --- | --- |
| Bad status | names the code — "the server returned 503" |
| Network gone | "Check your connection and try again" |
| Parse error | "came back damaged … a deploy may be in progress" |

The third is not hypothetical: a Pages deploy in flight serves `index.html` for
`anime.json`, which arrives as a JSON parse error rather than a bad status.
"Failed to fetch" is jargon to someone who just wanted a recommendation, so
nothing raw reaches the page.

**Typing reports the failure in the dropdown, not by replacing the view.** You
are mid-word in the search box; throwing the page away under your cursor to
report a failed background fetch is worse than the failure. The dice and a
shared link, which have already committed to the result view, get the full error
with a Try again button.

`#catalogue-notice` on the landing page is the one thing allowed to move layout
— it can push the credit line down. There is no card on that screen to keep
still, and at that point the page has nothing else to show.

`npm test` covers all of it, including that no path leaks an unhandled
rejection, which is the exact shape the original bug took. Run against build 30,
8 of the 11 checks fail.

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
powershell -c "Start-Process node -ArgumentList 'build-catalogue.mjs','--depth','8000' -WorkingDirectory $PWD -RedirectStandardOutput 'rebuild.log' -WindowStyle Hidden"
```

The builder only writes at the very end, so an interrupted run loses progress
but never corrupts the existing catalogue.

---

## Open

~~**Genres may be the wrong thing to match on.**~~ Fixed in build 33 for the
case that motivated it — see "A rare theme is worth a genre" above. Konosuba
now opens on Kage no Jitsuryokusha and Mushoku Tensei. **Two things are left
open, and neither is a reason to reopen the whole question.**

~~**The dense-tier half.**~~ Fixed in build 34 by scaling the affinity reach
with the anchor's position — see "A better match earns a longer jump" above.
GATE now opens Tsuki ga Michibiku, Drifters, Berserk: Ougon Jidai-hen, Juuni
Kokuki: five of its top six share Isekai or Military, against one before.

**The two fixes that did not work are kept below**, because both are the
obvious thing to try and both cost a day. Promotion only fires when the top tier is sparse and distant,
because that is the only time the frontier deletes the tier below. GATE:
Jieitai is the other shape — 31 shows share all three of its genres within 100
places, so nothing is promoted and proximity decides. Its first result *is* an
isekai (Tsuki ga Michibiku, 27 places up), but its second is Slayers at 37
with no shared theme, while Drifters — which shares Isekai *and* Military —
sits 195 away and loses on distance.

**Feeding signature themes into `affinity` does not fix this. Measured, not
guessed.** The idea is sound on paper: `preferLocally` already lets a better
match come forward `AFFINITY_REACH` positions per point, so a bonus per shared
signature theme should pull Drifters past Slayers. Three values were tried
against the 19 known anchors:

| Bonus | GATE fixed | Backtracks (18 at baseline) |
| --- | --- | --- |
| +1 | no | 20 |
| +2 | yes | 28 |
| +3 | yes | 29 |

**The value that fixes GATE is the value that breaks everything else, and the
two cannot be separated because the distances are the same size.** At +2,
Re:Zero shares Time Travel and Psychological with Steins;Gate, earning 120
positions of reach — enough to pull Steins;Gate (#5) to the second slot, which
drags the high-water mark to the very top of the rankings and defers
Evangelion, Madoka, Houseki no Kuni, Tian Guan Cifu, Berserk and Guimi Zhi Zhu
into the backtrack tail. Re:Zero's clean run of eight became a run of three. At
+3 the Arslan Senki bug returns outright: walking down from Berserk, Arslan
(#1594) leads over Wolf's Rain (#1204).

GATE's desired jump is about 158 positions. Berserk's forbidden one is about
138. No threshold divides them, so **this mechanism cannot tell them apart** —
which is the finding, and the reason not to retry it with a cleverer constant.

**What is left to try, and it is the riskiest edit in the file.** In both
failures the damage is not the reorder, it is that a jumped-forward candidate
*advances the frontier* and monotonicity then deletes everything behind it. A
candidate that comes forward on affinity could be made not to move the
high-water mark, so Steins;Gate could lead Re:Zero's chain without costing it
Evangelion. That is a change to the monotonicity rule itself — rule 3 of the
three that compete — so capture a baseline, change only that, and read all 19
anchors.

**Mushoku Tensei is unchanged, and that is the rule working.** Its genres are
Adventure, Drama, Ecchi and Fantasy — four, one of them rare — so nothing above
it shares all four and its top tier is *empty*. Promotion never creates an
empty tier, so the rule correctly declines to fire. Fixing this anchor means
promoting into nothing, which is the Arslan Senki failure. Leave it.

**Rarity is a good proxy for "identifying", not a perfect one.** Tokyo Ravens
is a magic-school show; its top result moved from Rakudai Kishi no Cavalry
(3 genres + School) to Maou 2099 (2 genres + Urban Fantasy), because School is
658 shows and Urban Fantasy is 77. Rakudai is arguably the better match and is
still second. One anchor out of seventeen went slightly the wrong way while
the rest improved, so the trade was taken — but if a better signal than raw
frequency is ever wanted, this is the evidence for it.

The old evidence, kept because it is what the fix was measured against:
Konosuba — genres Adventure, Comedy, Fantasy; theme Isekai — walked up to
Dungeon Meshi, Berserk, Made in Abyss, One Piece, Hunter x Hunter and
Fullmetal Alchemist: Brotherhood. Not one isekai.

The cause is that **genres are far too broad to identify anything**, while the
identifying word is filed as a theme and only breaks ties:

| Decides matching (genre) | Count | Only breaks ties (theme) | Count |
| --- | --- | --- | --- |
| Comedy | 1,276 | School | 652 |
| Action | 1,080 | Mecha | 265 |
| Fantasy | 968 | Isekai | 159 |
| Adventure | 871 | Harem | 142 |
| Drama | 740 | Psychological | 132 |
| Sci-Fi | 679 | Time Travel | 50 |

"Shares Fantasy" says almost nothing — it is a thousand shows. "Shares Isekai"
says a great deal. Re:Zero does reach Mushoku Tensei first, but only because
AniList tags give them a high cosine similarity; affinity can *reorder* a
genre bucket, it cannot pull a strong theme match in from outside one.

**Do not just swap genres for themes**, which build 33 deliberately did not do.
31 entries have no genres and are already handled by a special tier; far more
have no themes, and the ordering rules — match quality, then direction, then
monotonicity — are tuned against genre-sized buckets. Changing what *decides*
matching is the highest-risk edit in this project, and the working notes exist
because "obvious" fixes here have made things measurably worse before. Capture
a walks baseline, change one thing, read the diff anchor by anchor.

**A tip jar — "buy me a coffee" or similar.** Not monetisation in the sense
that matters legally: a donate link is not advertising, so it does not trip the
line that would force revisiting the MyAnimeList non-commercial and TMDB
personal-use registrations. **Check both registrations before adding anything
that looks like a business**, though — TMDB's definition of commercial is
broader than "makes money", and ads are the trigger, not deployment.

Practically it is one link in the footer next to the credit line. The card must
not move to accommodate it, so it belongs outside `.hero` with the other
explanatory notes.

**The voting system — stage one shipped, two and three to go.** "Have you
watched it" → "would you recommend it", a % recommend rating, and MAL XML list
import. Still the only part of the original idea needing a backend.

- ~~**Stage 1: remember what you have watched.**~~ Shipped in build 32. Local
  only, no server. See "The watched list" above.
- **Stage 2: the votes themselves.** Anonymous — a random id in local storage,
  no accounts. Ratings need votes, not identities, and holding strangers'
  credentials is a responsibility this project should not take on. Cloudflare
  already hosts the site, so Pages Functions plus D1 keeps it on one platform.
- **Stage 3: imported lists feeding the ratings**, behind a clear opt-in. This
  is the part that makes the numbers real: roughly 177,000 votes are needed for
  meaningful per-title percentages, which is why list import matters — a few
  hundred uploads does what millions of pageviews would.

**A percentage needs a floor before it is shown.** "100% would recommend" from
one vote is worse than no number at all. Nothing should display a percentage
until it has real support behind it — around 30 votes — and should say plainly
that it does not yet, rather than showing a figure that looks like data.

~~**Tune `AFFINITY_REACH` against real taste.**~~ Judged good as shipped —
30 positions per affinity point, 2026-08-19, by reading the live chains rather
than the test output. There is no ground truth here, so that verdict *is* the
evidence. Don't re-tune it without a reason and a fresh read of the walks;
60 was the other defensible value if one is ever wanted.

~~**31 entries can never be recommended.**~~ Build 29 made 28 of them reachable
by matching on themes in a tier below every genre match. Three have no genre,
theme or tag at all — Psychic Hero, Enter The Garden, Porte — and stay
unreachable, which is the honest end state rather than a gap.

~~**Small phones unverified below 390px.**~~ Checked at 360px, found bad, then
fixed and re-checked good in build 30. Sub-390 is not an edge case: 360px is
the most common Android width and the 12/13 mini, 375px the whole iPhone SE
line.

Two things were wrong. The **source's chip row shared the `.genre-row` class**
with the card, so it inherited the reserved rows despite changing only when
you search — the reservation is now scoped to `.hero .genre-row`. And the
mobile reservations, sized against a 430px Pro Max, were far too generous:
three title lines plus three chip rows plus three toggle rows put the card most
of a screen down. Both are two now, which covers 95% of titles at that width.

A `max-width: 400px` block trims chrome rather than content - smaller toggle
chips so the axis and format rows can share a line, smaller action labels so
"Open on MyAnimeList" stops wrapping and making its button taller than its
neighbour.

---

## Settled

Kept short; the reasoning that still matters has moved into the sections above.

- **Commit identity** — commits are authored with the GitHub noreply address
  `318438975+dvdngyn96-oss@users.noreply.github.com`, and both GitHub email
  settings are on: *Keep my email addresses private* and *Block command line
  pushes that expose my email*. History was rewritten once to remove a personal
  address, and GitHub Support ran a server-side garbage collection so the old
  objects are gone rather than merely unreachable. **Do not set `user.email` in
  this repo to a personal address** — the push will be rejected, and that
  rejection is the safety net doing its job, not a fault to work around.
- **Domain** — `whatanimeshouldiwatchnext.com`, registered through Cloudflare
  Registrar and attached to the Pages project as a custom domain. It is the
  canonical address and what all ten absolute URLs in the repo point at.
  `what-anime-next.pages.dev` still serves the same site and is still where
  deploys land, so neither address breaks.
  - `www` is a **proxied** CNAME to the apex plus a Redirect Rule — the
    *dynamic* kind, `concat("https://whatanimeshouldiwatchnext.com",
    http.request.uri.path)` with preserve-query-string on. A static redirect
    would dump everyone on the home page and silently drop the `?id=` that
    makes a shared recommendation a recommendation.
  - **Always Use HTTPS** is on at the zone. Without it `http://www/` never
    reached the rule and returned 522: the apex handled port 80 because Pages
    set that up for the apex alone. Worst case is now two hops —
    `http://www/?id=…` upgrades to HTTPS, then redirects to the apex, 200.
  - **Web Analytics needs no per-hostname setup.** The beacon token identifies
    the site, and hostname is just a dimension, so the apex and `pages.dev`
    both report into the same dashboard — confirmed by both appearing in the
    URL breakdown. The site's *label* still reads `what-anime-next.pages.dev`
    and that is cosmetic. Never add a second site for a new hostname: that
    issues a fresh token, and the old one is already in `index.html`, so the
    new dashboard would sit empty while the site kept reporting elsewhere.
  - Moving the domain again means moving all ten references together; `SITE`
    in `test/suite.mjs` is one of them, which is what makes the other nine
    enforceable rather than something to remember. And Facebook needs a fresh
    scrape afterwards: a changed `og:url` is a new URL to them, not an update.
- **Deployment** — live on Cloudflare Pages, auto-deploying from `main`.
  Build settings: preset **None**, build command **empty**, output `/`. The
  build command matters — Cloudflare's Workers import flow prefills
  `npm run build`, which here is the 60-minute catalogue rebuild.
  Cloudflare serves the whole repo root, so `package.json`, the `.mjs` scripts
  and `test/` are publicly fetchable; no secrets in them. `/.mal-client-id`
  returns `index.html` (the SPA fallback), not the file — it is not in the repo.
- **Analytics** — Cloudflare Web Analytics, as a manual beacon in `index.html`
  rather than the Pages setting, so it is visible in the repo and survives the
  site moving off Pages. Cookieless: no cookies, no fingerprinting, nothing to
  put a consent banner in front of. The token is public by design and belongs
  in the repo. Automatic setup was never on offer anyway — it needs the
  hostname to be a zone on the account, and `pages.dev` is Cloudflare's domain,
  not ours.
- **AniList tags** — landed build 19, affinity only. Needed no second harvest.
- **Genre backfill** — 42 of 74 recovered from AniList.
- **Recaps** — 23 dropped; `looksLikeRecap` keeps them out of future builds.
- **43 unverified entries** — settled by the build-16 rebuild, now 0. That
  rebuild also dropped 24 entries whose relation lookups had failed open.
- **Small phone** — the guess was wrong: the toggles were fine, the key art was
  the problem. Fixed in build 17 by lifting the identity block above the art.
- **Desktop after the mobile rework** — checked at build 19 and unchanged:
  poster overlapping the banner, identity block beside it, actions in one row,
  three-column grid. `display: contents` stays inside the ≤620px breakpoint.

---

## Explain things plainly

The person who owns this project is not a deeply technical developer. Write for
that, in the chat *and* in this file.

- **Say what a thing does before naming it.** "A redirect rule, which sends
  anyone typing the www address over to the real one" beats "a dynamic redirect
  on `http.host`".
- **Spell out the consequence, not just the mechanism.** "PNG can't compress a
  radial gradient" means nothing on its own; "that glow was three quarters of
  the file size" does.
- **Jargon is fine once it has been explained once.** The goal is not to avoid
  technical words, it is to avoid unexplained ones. This file is full of them
  deliberately — every one gets defined where it first matters.
- **Give the recommendation, then the reasoning.** Not a survey of five options
  weighted equally. Say which one and why, and note what would change the answer.
- **When something cannot be done, say so in one sentence** and give the thing
  that can be done instead. Blocked tool calls, GitHub settings, purchases and
  anything needing a login all fall here.
- Screenshots are how bugs and dashboard confusion get reported here, and they
  work well. Assume the dashboard has been redesigned since training and check
  the actual state before giving directions through a UI.

## Working notes

- Verify against data rather than assuming. Several "obvious" fixes in this
  project made things measurably worse and were reverted — check known-good
  walks (`npm run walks`) *before* declaring a change good, not after.
- **Capture a walks baseline before touching the matcher, and diff.** For a
  change meant to preserve behaviour, byte-identical output is the proof. For a
  change meant to improve it, the diff is the only evidence there is — read it
  anchor by anchor. The tags work looked finished and was silently dropping
  Steins;Gate's three nearest matches; only the diff showed it.
- **Check the anchor list actually covers the thing being changed.** Not one of
  the fourteen anchors was an isekai, so the walks harness could not see the
  problem the Open section had been describing for weeks. Add the anchors
  first, as a separate step, and confirm the existing ones come out
  byte-identical — then the baseline contains the bug and the diff can show
  the fix.
- **A results window too short to reach the known-good result is a baseline
  that lies.** Steins;Gate printed five, and when four nearer matches were
  inserted ahead of it the documented tail — Shinsekai yori, Serial Experiments
  Lain, Texhnolyze, Inuyashiki — fell off the end and read exactly like the
  regression this project fears most. Nothing had been lost. Widened to nine.
- **Break a new guard on purpose and watch the check fail.** Both promotion
  guards were asserted against four anchors, and the empty-tier one passed with
  the guard deleted — none of those four could reach the case. Made in Abyss
  and Monster can, and now do.
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
