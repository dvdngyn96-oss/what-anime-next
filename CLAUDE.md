# whatanimeshouldiwatchnext

Type an anime you've already watched; get the next one **up the MyAnimeList
rankings** that shares its genres. A blank Google-style page, a search box, and
a card.

Static site. No build step, no server, no runtime API calls for the core loop.

---

## Current state

**Build 54.** `anime.json` holds **5,017 entries**
(TV 3,178 · ONA 766 · OVA 481 · **Film 592**), about 1.74 MB.
389 checks pass via `npm test`.

| Data | Coverage |
| --- | --- |
| Key-art colour | 4,636 |
| Banner image | 3,047 |
| Studio | 4,758 |
| AniList tags | 4,498 (90%) |
| MyAnimeList score histogram | 5,017 (100%) |
| Genres backfilled from AniList (`gs`) | 71 |
| No genres (matched on themes only) | 61 |

**The scan depth is 10,000, raised from 8,000 in build 48.** It added 933
entries, and it was raised because somebody asked for a specific show the
depth excluded — Kämpfer, MAL rank 8919, with perfectly clean relation data.
That is the first time the depth turned anyone away rather than the catalogue
rules doing it, which is what made it worth the longer rebuild.

**A rebuild now takes about two and a half hours.** The ranking scan is quick;
the per-entry relation lookups are the cost, and films took them from 6,929 to
**8,649**. The builder's own "~49 min" estimate for that phase assumes the
340ms gap between requests and is wrong by a factor of three — real latency
makes it closer to 140 minutes. Budget the afternoon.

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
npm test          # 378 checks, jsdom against the real app.js and anime.json
npm run walks     # prints recommendation chains for 19 known anchors
npm run build     # full catalogue rebuild + prerendered pages, ~2.5 hours
npm run pages     # prerendered pages only, ~30 s
```

One credential file, gitignored, **build-time only** — nothing ships in the
browser:

- `.mal-client-id` — MyAnimeList API, registered **non-commercial**

`.tmdb-key` is no longer read by anything as of build 40 and can be deleted.
AniList needs no key, for the build-time tag harvest or the runtime lookups.

**And that is the whole monetising constraint gone.** MyAnimeList's
non-commercial terms define it as "personal, educational, open source or
communal" and explicitly allow *"donations without any quotas"*, plus some
advertising. TMDB was the strict one — it counted "indirect monetization
through traffic generation" as commercial and said outright that donations
*"may be considered commercial"* — and it is no longer a dependency.

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

**A share, not a count.** 5% of 4,427 entries is 221 shows: Isekai (199),
Harem (182), Military (181), Super Power (172), Music (170) and rarer count;
Martial Arts (250), Adult Cast (282), Mecha (341), Historical (455) and School
(793) stay tie-breakers. A fixed count of 200 looks identical on this
catalogue and is a trap — in a six-entry test fixture every theme is
under 200, so everything became a signature theme and five checks failed at
once. Rarity only means something relative to the corpus. Counted at load, so a
rebuild cannot leave it stale.

**Build 48 proved that the hard way, in the good direction.** Raising the scan
depth added 933 entries, a 27% jump, and the signature set came out **47
themes before and 47 after — nothing gained, nothing lost.** Every theme near
the boundary grew roughly in proportion to the catalogue, which is exactly
what a share measures and a fixed count would have missed. Martial Arts went
207 to 250 against a cutoff moving 175 to 221, and stayed a tie-breaker
throughout.

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
  either way. Since build 40 the listings arrive from AniList rather than the
  catalogue, so the row is a *reserved* 26px line rather than one that wraps
  freely — see "Where to watch" below.
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

### A card you have already been shown never comes back

Build 48, and **the first bug a stranger found.** Reported in a comment on the
r/anime post, in these words:

> If you start with Re:Zero without a profile, it'll recommend Mushoku Tensei.
> If you click "Show me another", it'll show you Evangelion. If you then click
> "Seen it too — drop it", it'll go back to Mushoku Tensei.

Reproduced exactly, and their diagnosis was the right one: *"anything in the
chain is an implicit rejection."*

**`chainHistory` is what the walk is told to skip, and only two things fed
it** — the anchor, and whatever you pressed "Seen it too" on. **"Show me
another" fed it nothing.** It only advanced `state.index` through a list that
had already been computed, so the entries you paged past were never recorded
as seen. `refreshFromAnchor` then re-walks and resets the index to 0, putting
every one of them back at the top.

So it was a bug of omission rather than a design question. The set is
documented as "anime already dismissed against the current anchor, so they
don't come back", and one of the two paths that should have fed it did not.

`rememberShown()` records the card being left, called from **"Show me another"
and from clicking a card in the grid** — both mean "not this one". It is
called when *leaving* a card, never when arriving at one, so the entry on
screen is never in the set; otherwise a re-walk would exclude the thing you
are looking at and the card would change under you.

#### The fallback that made it look like a different bug

`walkRankings` already ended with this, and it is easy to miss:

```js
// Everything nearby has already been dismissed — rather than dead-end,
// forget the history and allow repeats.
if (!list.length && exclude.size) return walkRankings(source, direction, new Set());
```

That is old behaviour and still the right call — a dead end is worse than a
repeat. But it was **silent**, and recording paged-past cards makes it far
easier to reach, because the history now grows with every click rather than
only when you drop something.

**A silent restart is indistinguishable from the bug that was just fixed.**
One is the design working and the other was a defect; the reader could not tell
them apart, and neither could anyone else. So the restart now says so, under
the card with the other notes: *"You have been shown everything higher up the
rankings that matches, so the list has started again — you will see repeats
from here."*

**A counter for it was built and then removed, which is worth recording so
nobody builds it again.** The plan was to let an emptied walk blame the chain
history, the way build 39 let it blame the watched list and the year chip —
which meant moving the exclude test after the match test so it could be
counted. It was written, and then the fallback above made the whole branch
**unreachable**: the walk retries before it can ever return empty from chain
history alone. The test moved back to where it was, cheap and early, and the
restart note does the job instead.

**Dropping also writes to the watched list, so the two causes stay separate.**
Paging past something is undone by searching again; dropping it is not,
because "seen it" is taken at its word and written to `wanx:watched:v1` for
good. Offering "search it again to start over" for a dropped title would be
advice that quietly does nothing.

`npm run walks` came out **byte-identical**: the shuffle path never recomputes
the walk, so recording what it passes only takes effect on the next re-walk.
Four checks cover it, and the fix was broken on purpose — the failure prints
`Fourth Match -> Third Match -> Fourth Match`, which is the reader's report in
miniature.

Verified against the real catalogue with their own titles: Re:Zero → Mushoku
Tensei → *show me another* → Evangelion → *seen it too* → **Gyakkyou Burai
Kaiji**, where it used to return Mushoku Tensei.


### The format filter

Four chips — **TV / ONA / OVA / Film** — in a third toggle row, each
independently on or off, defaulting to all on and remembered in
`localStorage`. Film joined in build 52; see "Films are a fourth format"
above for why it was excluded before and what changed.

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

### Films are a fourth format

Build 52. **TV / ONA / OVA / Film**, four chips, each independently on or off,
all on by default.

Films were excluded outright until now, on the grounds that they are "usually
either a franchise entry or a different watching decision". **The first half
was measured and does not survive contact with the relation rules.**

Checking all 1,720 films in MyAnimeList's top 10,000 against the same
prequel / parent_story / full_story test the builder already applies:

| | Startable cold |
| --- | --- |
| TV, OVA, ONA | 64% |
| **Film** | **32%** |

So films really are twice as likely to be franchise entries — but the rules
already remove those. What survives is not filler: **Koe no Katachi (#22),
Kimi no Na wa (#37), Spirited Away (#47), The First Slam Dunk (#67), Howl's
Moving Castle (#80), Princess Mononoke (#81), Look Back (#111), Perfect Blue
(#136), Grave of the Fireflies (#142).** The relation test strips the Gintama
and Fate entries and leaves the films that genuinely stand alone.

**The second half of the objection stands, and is why this is a chip rather
than a silent addition.** A two-hour film *is* a different decision from a
twelve-episode series, and somebody in the mood for a season does not
necessarily want one. That is the argument ONA already won: the answer to
"some people do not want this kind of thing" is a switch, not an exclusion.

**On by default**, like the other three. The startable set is strong enough
that hiding it behind an opt-in would mean most people never see Spirited Away
in a catalogue that now contains it.

#### The fourth chip cost two pixels of padding, and that was measured

Adding it naively pushed the toggle block from **68px and two rows to 105px and
three** at 360px — the exact regression builds 30 and 39 both fought, and the
reason the year filter had to ride in the gap beside the direction toggle
rather than take a row of its own.

It overran by about 13px. Dropping `.formats button` padding from `6px 9px` to
`6px 7px` inside the existing `max-width: 400px` block buys it back:

| | Toggle block at 360px |
| --- | --- |
| Four chips, padding unchanged | 105px, three rows |
| Four chips, padding `6px 7px` | **68px, two rows** |

Checked at 360, 375 and 414. A check reads the rule out of `styles.css`,
because jsdom has no layout — and it was broken on purpose to watch it report
the old padding.

**This is the second time the toggle row has been the binding constraint on a
feature**, after the year chip. Anything added there from now on has to be
measured first: at 360px row one has about 15px spare and row two about 27px,
which is not enough for anything with a word in it.


#### Two things the first film rebuild taught, both the hard way

**A film that continues a series is not caught by the relation rules, and 20%
of films are one.** MyAnimeList files Gintama Movie 3 with no prequel at all —
the same blind spot that lets Hayate no Gotoku!! through on the TV side. The
first build with films put **Gintama Movie 3 at #65**, near the top of what the
site would recommend. The builder now drops a film whose title begins with the
title of a non-film already in the catalogue, which removed **148 of 740**.
`STANDS_ALONE_ANYWAY` overrides it, because the rule costs a few real ones —
Macross: Do You Remember Love is a standalone retelling rather than a
continuation, the Hellsing Ultimate case in film form.

**And the home page was promising something it no longer delivered.** The
tagline said *"You'll get a TV series you can start from episode one"*, and the
Open Graph description said *"no sequels, no films"* — both false the moment
films shipped, and the second was drawn into `og.png` as well, so the preview
image had to be regenerated rather than just re-worded. The tagline is now
*"You'll get something you can start from the beginning"*.

Worth generalising: **a catalogue change can falsify copy in four places** —
the tagline, the meta description, the two social descriptions, and the text
baked into the preview image. Grep for the claim, not just the file.

#### Returning visitors would have had films switched off

`wanx:formats` holds whichever formats are on, and every existing visitor has
`["TV","ONA","OVA"]` saved — not because they turned films off, but because
films did not exist. Loading that literally leaves films off for everyone who
has ever used the site, silently, over a choice they never made.

So a saved set that is *exactly* the old three is read as "no opinion
expressed" and gets films too. A set with anything genuinely switched off is
left alone. A check covers both halves, and removing the migration fails it.

**This will apply again to any future format**, and the same trap is waiting in
`wanx:excluded` and any other stored set that gains a member.

### The year filter

Build 39. **One chip — "2010 or later"** — off by default and remembered in
`localStorage` under `wanx:modern`. 41% of the catalogue is older than 2010
(1,427 entries against 2,053), and bouncing off older art and pacing is a real
preference rather than a taste to be corrected.

The matcher side is the well-trodden part: it filters *candidates* exactly like
the format filter, so `npm run walks` comes out byte-identical apart from the
build-number line. **The risk was vertical space**, and that is where the work
went.

**It rides in the existing toggle row, and the DOM position is what makes that
true.** Three toggle rows on a 360px phone already pushed the card most of a
screen down once, and the fix for that was cutting reserved space from three
rows to two — a fourth row would have undone it. Measured in a real browser
rather than guessed:

| Where the chip sits | Toggle block at 360px |
| --- | --- |
| Appended at the end of `.controls` | 105px, three rows |
| Second, straight after the direction group | **68px, two rows** |

The direction toggle is 208px wide inside a 320px container, so 104px beside it
was going spare; the chip is 89px. The axis and format groups keep sharing the
line below. Checked with and without the chip at 360, 375, 414 and 1280px — the
block is **the same height either way at every one of them**. A check asserts
the chip is inside the second `.direction` group, because jsdom has no layout
and DOM order is the thing that actually produces the result.

That is also why the label is the full "2010 or later" rather than "2010+".
Once it fits, the clear wording is free.

**It filters candidates, not anchors** — the same rule as the format and
watched filters. "I watched this in 1998, what next" is exactly what the site
is for. "Surprise me" does respect it, because being handed a 1979 mecha right
after asking for 2010 or later reads as the toggle being broken.

**An entry with no year on record is kept.** 13 are in that state, and that is
a gap in MyAnimeList's data rather than an era anybody chose to exclude — the
same rule as an entry with no type surviving the format filter.

**On is the loud state here, which is the opposite of the format chips and is
deliberate.** Those default to on, so switching one *off* is the only choice
being expressed and the only thing that should draw the eye. This one defaults
to off, so switching it *on* is the choice — it takes the plain accent fill
that direction and axis use, and needs no new CSS at all.

**There is no "N shows were skipped" note, unlike the watched list.** The
counter exists and an emptied walk names the filter, but nothing appears under
an ordinary card. The watched list is invisible state built up over months, so
its effect has to be explained; the chip is on screen directly above the card
with its own state showing, and was just pressed. "684 shows released before
2010 were skipped" tells nobody anything — and 684 is the ordinary size of that
number, not an outlier. The format filter is visible in the same way and is
silent for the same reason.

**The chip alone cannot actually empty a walk**, which was worth checking
rather than assuming. Ten anchors come out empty with it on, and all ten have
no genres — and a genre-less *anchor* is already turned away earlier with its
own message, so none of them reach the walk. The realistic empty is the chip
plus a large watched list, and that branch names both: "877 already on your
watched list, 684 released before 2010."

Walking down from Cowboy Bebop with it on: Cyberpunk: Edgerunners, Pluto,
Psycho-Pass, Uchuu Senkan Yamato 2199, Kaijuu 8-gou — against Captain Herlock,
Space Cobra and Tenchi Muyou with it off.

### Both filters count what they actually removed

Build 39 fixed a bug the year chip made impossible to miss. `watchedSkipped`
and `yearSkipped` feed a sentence that says "shows that **matched**", so they
have to count matches — and they were being applied beside the format filter,
*before* the genre test. `collectTiers` walks the entire catalogue in each
direction, so the number reported was really the size of the filter itself.

Marking 40 sports shows watched made Cowboy Bebop — Action, Award Winning,
Sci-Fi — report "40 shows that matched are already on your watched list", when
it shares a genre with exactly three of them. The year chip said **1,426**,
which is the whole pre-2010 catalogue.

Both counted filters now sit *after* the match test. The format filter is
deliberately left where it was: it is uncounted and unreported, so its position
cannot mislead anyone, and leaving it early keeps the scan cheap.

**The first version of the check passed with the bug reinstated**, which is the
`empty-tier` lesson again. The test seeded the watched list *after* `makeDom`,
and `app.js` reads it into module scope on load — so the page ran on the
defaults and the check proved nothing. `makeDom` now takes `seedWatched` and
`seedModern` and sets them before the script boots. Both new guards were then
broken on purpose and watched to fail.

### When there is no tier to demote into

Build 47. Both demotions — Kids, and the length mismatch — drop a candidate one
tier so it surfaces once closer matches are exhausted. The floor is 1, because
tier 0 holds entries with no genres at all matched on a shared theme alone, and
a real genre match must never sink below those.

**But when a candidate already shares exactly one genre, that move lands it
back where it started and the rule silently does nothing.** A source with one
genre has no tier above 1 at all, so for those anchors *neither demotion has
ever fired*.

**854 entries — 24.4% of the catalogue — have a single genre**, most commonly
Comedy (241), Slice of Life (123) and Drama (87), and 758 of them have a
6x-longer genre match somewhere in range. Two-genre sources are affected too,
in their 1-of-2 tier.

**Found by clicking the live site.** Kindaichi Shounen no Jikenbo — 148
episodes, one genre — returned Meitantei Conan, whose length `lengthOf`
estimates at 1,200 episodes from a run starting in 1996, against a threshold of
148 × 6 = 888. It cleared the bar comfortably and nothing happened. Worse,
build 35's own measurement table already listed **Ame to Kimi to (12) reaching
Chi's Sweet Home (104) at 8.7x** as a case to demote — and it was sitting
*second* in the shipped walk the whole time.

**The fix is to demote within the tier rather than out of it.** A clashing
candidate that cannot move down sorts to the back of its own bucket, behind
everything that did not clash. Same intent, one step smaller, and the floor
stays exactly where it was.

**Applied after `preferLocally`, not before**, which matters: sorting the
clashes to the back first would let the affinity lookahead pull one forward
again, and the rule would half-fire.

**The flag is cleared for every surviving candidate**, because these are the
shared catalogue objects and genre-less entries never reach the clash site —
a value left over from the previous walk would sink an entry for no reason.

**One line of the 19 known anchors moved.** Ame to Kimi to's second result went
from Chi's Sweet Home (104 episodes, 8.7x) to Kanojo to Kanojo no Neko (4
episodes, 0.3x), and Chi's Sweet Home moved to position 26 of 108 — demoted,
not deleted, which is the whole design. Everything else, including Haikyuu!!
and its legitimate run to Slam Dunk and Hajime no Ippo at 4.0x, came out
byte-identical. Ame to Kimi to's demoted set reads correctly too: Aikatsu!
(178), PriPara (140), Aikatsu Stars! (100) — and Rilakkuma to Kaoru-san at 13
episodes, which is the *Kids* rule firing, equally dead until now.

### Kids is demoted

`Kids` is the one demographic marking a different *audience* rather than a
different tone. Without demoting it, a 12-episode dark isekai recommends
Pokémon — 276 episodes, same three genres, 48 places away. Affected 54 anchors.

### And a 220-episode series is demoted against a 12-episode one

The Kids rule was half a fix and build 35 is the other half. **Length was never
looked at.** GATE: Jieitai is 12 episodes and its fifth result was Naruto at
220 — which shares all three of its genres and sits 283 places up, four behind
Juuni Kokuki, so it arrived in perfectly correct order. Nothing was
misbehaving; the code had no idea it was asking for a 220-episode commitment.
Pokémon is caught against a short isekai for being *Kids*. Naruto is Shounen,
so nothing caught it — and GATE has no demographic recorded at all, so that
tie-breaker could not fire either.

A candidate `LENGTH_MISMATCH` (6) times longer than the source drops one tier,
exactly like Kids, so it surfaces once closer-sized matches are exhausted.

**A ratio, never an episode count, and the threshold came from measurement.**
Every length ratio actually served across the 19 anchors was collected — 150
pairs. The legitimate ones stop at 5.8x and the questionable ones start at 7x:

| Ratio | Pair | |
| --- | --- | --- |
| 18.3x | GATE (12) → Naruto (220) | demote |
| 14.8x | Konosuba (10) → Hunter x Hunter (148) | demote |
| 11.8x | Overlord (13) → Dragon Ball (153) | demote |
| 8.7x | Ame to Kimi to (12) → Chi's Sweet Home (104) | demote |
| 7.0x | Tokyo Ravens (24) → InuYasha (167) | demote |
| 5.8x | Mushoku Tensei (11) → FMA:B (64) | keep |
| 4.0x | Haikyuu!! (25) → Slam Dunk (101) | keep |
| 3.1x | Steins;Gate (24) → Monster (74) | keep |

A clean gap, which is more than could be said for anything separating the
cases that defeated the affinity work — there the wanted jump was *larger*
than the forbidden one. Haikyuu!! legitimately reaches Slam Dunk, Hajime no
Ippo, Touch and Diamond no Ace, and a blunt episode count would have wrecked
that chain; its whole run tops out at 4.0x and comes out byte-identical.

**A missing episode count is estimated, not ignored, and skipping that step
broke the rule on its first run.** All 38 entries without a count are currently
airing — which covers One Piece and Meitantei Conan, the two longest things
here, *and* a series three episodes into its first season. Treated as unknown,
the rule demoted Dragon Ball at 153 episodes and One Piece, at more than a
thousand, walked into the slot it had just vacated. `lengthOf` now estimates
from run length once a show has been airing `LONG_RUNNING_YEARS` (5): a weekly
series broadcasting since 1999 has over a thousand episodes whatever the
catalogue says. Below five years it stays unknown and earns no penalty, the
same rule as a missing demographic.

Episode count still overstates shorts — Chi's Sweet Home is 104 episodes of
about three minutes — and there is no duration field to correct with.

15 of the 19 anchors came out byte-identical. The four that moved each lost
exactly one over-long entry: GATE drops Naruto, Overlord drops Dragon Ball
*and* One Piece, Konosuba drops Hunter x Hunter and One Piece, Tokyo Ravens
drops InuYasha. Backtracks went 22 to 25.

**Growing the catalogue moves these results without changing a constant, and
build 48 is the evidence.** Raising the scan depth from 8,000 to 10,000 added
933 entries, and GATE went from opening *Tsuki ga Michibiku, Drifters, Berserk*
to *Tsuki ga Michibiku, **Slayers**, Drifters, Berserk* — Slayers back at
second, which is the exact symptom build 34 was written to remove.

**Everything that could explain it was checked, and none of it changed:**

| | Before | After |
| --- | --- | --- |
| GATE / Slayers / Drifters genres and themes | identical | identical |
| Affinity (Slayers, Drifters) | 2, 3 | 2, 3 |
| Distance from GATE, in positions | 37, 195 | 45, 206 |
| Drifters' place in the lookahead window | 21 of 30 | 21 of 30 |
| Reach budget | 60 (capped) | 60 (capped) |

So the cause is the **composition of the bucket** — 933 new entries interleaved
among the candidates. `preferLocally` reorders inside a window, so the outcome
can move even when both entries involved are untouched and the constants are
identical.

**That was not re-tuned, and should not be.** The reach value was judged by
reading live chains rather than by a metric, so there is no number to optimise
back to; and re-tuning on one anchor is how all three reverted fixes above
started. The degradation is also mild — GATE's first result is still an isekai
and Drifters only moved from second to third.

**What it does mean is that a rebuild is a behaviour change, not just a data
refresh.** 12 of the 19 anchors came out byte-identical by title, six moved by
small reorderings, and one moved in a way worth arguing about. Read the diff
after every rebuild, not only after a matcher edit.

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

### The franchise-sibling sweep

Build 48. **Found by clicking the live site**, like most real bugs here: Crest
of the Stars would not come up.

It was not a search problem. **Seikai no Monshou is MAL rank 1683** — well
inside the 8,000 the builder scanned at the time — so it had been seen and
rejected. Its relations:

| Relation | Target | Effect |
| --- | --- | --- |
| sequel | Seikai no Senki | harmless |
| **prequel** | **Seikai no Danshou: Tanjou** | dropped it |
| summary | Seikai no Monshou Special | harmless, points the other way |

And that prequel is a **one-episode TV special that aired 25 August 2000**,
more than a year *after* the 1999 series it supposedly precedes. Exactly the
Re:Zero shape this file already describes.

**Both earlier sweeps looked at it and passed**, and why is the useful part.
They asked whether *the prequel's title starts with the show's own title*.
Here it does not:

```
Seikai no Monshou   the series, 1999
Seikai no Danshou   the "prequel", a 1-episode special from 2000
```

Same franchise prefix, different word, so a `startsWith` test slid straight
past. **A title test cannot see a franchise sibling.**

#### Sweeping on the shape of the relation instead

`prequel-sweep.mjs` — gitignored scratch, like `full-scan.mjs` — checks every
entry missing from the catalogue whose *only* disqualifier is a prequel, and
keeps the ones where **every** such prequel is a short non-TV thing of two
episodes or fewer. That is what a pilot, an episode 0, a recap special and a
later side film all look like, whatever they are titled. `tv` is deliberately
excluded: a full TV series listed as a prequel is the case to keep out.

**It is much noisier than the title test, and the reason is worth knowing.**
Over the top 3,000 it flagged **84**, and 57 were later seasons — Hibike!
Euphonium 3, Natsume Yuujinchou Shichi, Spice and Wolf II, KonoSuba 3.
**MyAnimeList lists the most recent side story as the immediate prequel rather
than the previous season**, so a test on the shape of the relation cannot see
that the real blocker is season one.

The discriminator is the catalogue itself: "Hibike! Euphonium 3" extends
"Hibike! Euphonium", which is already here, so it continues something we
carry. "Seikai no Monshou" extends nothing. Cutting anything whose title
extends an existing entry left **27**, and a human read all 27.

**Ten were added.** Moomin, Fate/strange Fake, Dead Dead Demons Dededede
Destruction, The King's Avatar, Luo Xiaohei Zhanji, Keroro Gunsou,
Planetarian, Golgo 13 (TV), Tekkaman Blade and Long Zu.

**Seventeen were rejected, and they are the same lesson this list keeps
teaching.** Aria the Origination, Tsurune season 2, Grisaia no Rakuen, K:
Return of Kings, Major 2nd, Ranma ½ Super — and **New Game!!** and **Hayate no
Gotoku!!** again, where `!!` is the only thing in the entire dataset that says
"season two". Hayate was flagged and rejected by the earlier sweep too, which
is a useful sign the noise profile has not changed.

So the sweep is a **candidate generator, not a rule**, and more emphatically
than the title one: two thirds of its raw output is wrong. Do not be tempted to
run it unattended.

**Reachability was checked directly, not inferred from the walks diff.** None
of the 19 anchors goes near rank 1683, so an unchanged diff would have proved
nothing — the same reasoning as adding entries below rank 955. Walking up from
twelve anchors just below Crest of the Stars, **12 of 12 reach it**. Moomin
turned up independently as Yuru Camp's fourth result once the rebuild landed.

**Adding it properly beats the live AniList lookup, which is the part that is
easy to miss.** Typing a title that is not in the catalogue pulls it from
AniList as an anchor — it works, but the entry carries only AniList's three
genres and can never be recommended *to* anyone. In the catalogue it picks up
**Military and Space as themes**, both signature themes under the 5% bar, so
it now finds the other space opera.

That live-anchor path also produced a copy bug the same screenshot showed:
`rankLabel` returned a bare `#5` or `not in the ranking`, and the card wrote
`ranked` in front of it — so every live-fetched entry read **"ranked not in
the ranking"**. The label carries the whole phrase now, because the two halves
want different grammar. A check covers it, broken on purpose to watch it print
the offending sentence.


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

**The sweep was then run over the whole catalogue**, not just the 125 entries
whose titles extend another entry's — that shape was a guess about where
re-cuts live, and guessing where to look is how the first 27 were found rather
than all of them. `full-scan.mjs` checks every entry for the relation and
checkpoints to `full-scan.jsonl` so an interrupted run resumes; both are
gitignored. All 3,505 entries, zero errors, **12 more found**: Initial D Battle
Stage, Yozakura Quartet: Hoshi no Umi, Gundam Wing: Operation Meteor, Love Hina
Final Selection, 30-pun de Wakaru! Love Live!, Tenjou Tenge: The Past Chapter,
Karneval OVA, Fate/stay night TV Reproduction, Mahou no Yousei Persia, Flag
Director's Edition, Honoo no Alpenrose and Pretty Rhythm: All Star Selection.

**343 entries carry `summary` and every one of them stays.** That is the
reassuring half of the sweep: the relation that points the other way is nearly
thirty times more common than the one that disqualifies, so reading the two as
equivalent would have gutted the catalogue.

**This was found by clicking through the live site**, not by the suite: an
Overlord chain reached the One Piece re-broadcast at its sixteenth result.
39 entries removed in total. `npm run walks` came out **byte-identical**, which
proves nothing — none of the seventeen anchors reached any of them — so it was
verified directly instead, by walking from Overlord and confirming the entry is
gone. Same reasoning as adding entries below rank 955.

The twelve from the full sweep were checked the same way and it mattered:
**11 of the 12 were reachable** before removal, walking up from sources placed
just below each one. A byte-identical walks diff would have said nothing about
any of them.

Each build prints well-regarded OVAs/ONAs it dropped, formatted as ready-to-paste
IDs. That list is a judgement call for the human, not something to automate.

To add one without a 60-minute rebuild: add the ID, then
`node add-one.mjs <mal-id>`.

---

## Shipped behaviour

### The site is more than one page now

Build 45. Until this, **Google had exactly one document to rank** for a site
whose domain is the question people type into Google. Every result lived at
`/?id=N`, the card was built by `app.js` after the crawler had gone, and the
canonical on all 3,493 of them pointed back at the root — which tells a
crawler outright not to index them separately. The sitemap listed two URLs and
said so in a comment.

**Results are prerendered now, one document per entry**, at
`/anime/<id>/<slug>`. 4,379 pages — the 48 entries with no genres are skipped
rather than shipped as pages with nothing on them. Each carries its own title,
description, canonical, Open Graph tags, an `<h1>`, the anime's own facts, and
eight recommendations with a line on why each matched.

**The long tail is the point.** Nobody needs to find the home page: "what to
watch after <show>" is thousands of low-competition queries this catalogue can
already answer, and every page links onward to eight more, so a crawler can
walk the whole catalogue from any entry point.

**`build-seo-pages.mjs` drives the real `app.js` rather than reimplementing
the walk.** The matcher is the highest-risk code here and a second copy would
drift quietly somewhere nobody looks, so the generator boots `index.html` and
`app.js` in jsdom exactly as `test/walks.mjs` does and calls the same
`walkRankings`. That also keeps it honest: a crawler is served the same
recommendations a visitor gets, which is the line between prerendering and
cloaking.

**It is wired into `npm run build`**, so a rebuild still ends with a
release-ready site — the property build 40 bought by dropping TMDB, kept.
`add-one.mjs` regenerates them too, rather than printing a reminder, because
"a step you have to remember" is exactly the footgun that was removed. The
whole pass takes about 25 seconds against the builder's 60 minutes.

**Every path the page fetches had to become absolute, and finding that out is
what the prototype was for.** The first attempt rendered as unstyled HTML with
no app on it: `index.html` referenced `app.js` and `styles.css` relatively, and
`app.js` fetched `anime.json`, `api/ratings` and `api/vote` relatively — so
from `/anime/9253/steins-gate/` every one of them resolved into the
subdirectory and 404'd at once. `goHome()` had the same bug, pushing `'./'`,
which meant `/anime/9253/` instead of the home page. Five checks guard the
absolute paths and two were broken on purpose to watch them fail.

**Hydration replaces the crawler block rather than sitting beside it.** The
prerendered `#seo-content` is removed the moment the app has a real card up,
so nobody sees both — and it is left alone when JavaScript never runs, which
means the page still says something useful without it.

**`/?id=N` keeps working.** Links shared before this exist and must not rot, so
`routeFromUrl` reads the path first and falls back to the query. The slug is
decorative to the app, which routes on the id alone, so a stale or mistyped
slug still resolves — and duplicate slugs across different entries (`cat-s-eye`,
`digimon-adventure`) are harmless for the same reason.

**Every URL carries a trailing slash, and shipping without it was a real bug.**
A page written to `anime/<id>/<slug>/index.html` answers 200 at
`/anime/<id>/<slug>/` and **308-redirects** the bare path to it. Build 45 put
the bare form in the sitemap, the canonical and every internal link — so the
sitemap pointed a crawler at 3,462 redirects, which spends crawl budget and
weakens the signal that arrives. Found by calling the deployed site rather than
by reading the file, which is how most real bugs here get found. Two checks
guard it and one was broken on purpose to watch it name the offending URLs.

**The sitemap is generated, not hand-written**, because it has to list exactly
what was produced or it points crawlers at documents that are not there. It
lists 4,381 URLs now. The old comment explaining that listing them all would be
duplicate content was true when every one served identical markup, and is not
true any more.

**Cost: about 53 MB on disk across 4,379 directories, and a couple of MB in
the pack.**
Near-identical files delta-compress hard, so the repository grew far less than
the working tree suggests.

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

~~**`sitemap.xml` lists one URL.**~~ True until build 45, and the reasoning was
sound while it lasted: every `/?id=N` served byte-identical HTML, so listing
them would have handed a crawler thousands of URLs with the same markup, which
is what duplicate content means. They are distinct documents now — see "The
site is more than one page now" above — so the sitemap lists all 4,381 and is
generated rather than hand-written.

### Where to watch

Build 40, and it replaced TMDB outright. The row itself is unchanged in shape
— that was the constraint, since `.watch` is part of the constant-height
design and a check asserts it renders either way. What fills it changed.

**TMDB failed more often than it worked.** It matched 3,149 titles but carried
US or Canadian listings for only 1,641, so **53% of cards said "No listing
found"**. It also cost a separate twenty-minute refresh pass whenever listings
went stale, a second credential, and 76 KB in every visitor's download.

**AniList carries the same thing on a request the card already makes.**
`externalLinks` has a `type: STREAMING` entry per service with a real URL, and
`fetchDetails` was already fetching the synopsis and trailer per card — so the
listings cost **no extra request at all**. Measured on an even 600-title
sample across the whole ranking range, not on famous titles:

| Source | Coverage |
| --- | --- |
| AniList `externalLinks` | **69.0%** |
| TMDB `wp` | 50.1% |

AniList picks up 124 titles TMDB missed and loses 12. "No listing found" falls
from about half of cards to 29%. The commonest services are Crunchyroll,
YouTube, Hulu, Netflix, Bilibili TV and Prime Video.

**It was verified before anything was designed around it.** The previous
session recorded this field as *unconfirmed*, because AniList was answering
`403 The AniList API has been temporarily disabled` at the time. The API is
back; the query was run against Frieren and returned six streaming links
before a line of code was written.

**A chip is now a link.** TMDB gave a provider *name*; AniList gives the URL
of the title on that service, so each chip goes straight there rather than
bouncing through a "check current" link to TMDB.

**The row had to become a reserved height, and that is the one real risk in
this change.** It used to be filled synchronously from the catalogue, so
`flex-wrap: wrap` was harmless. Now it fills a moment after the card renders,
and a row that grows when the request lands shoves every button below it —
exactly the jitter the card exists to avoid. It is `height: 26px`,
`flex-wrap: nowrap`, capped at `MAX_SERVICES` (4) and clipped past that. A
check reads the rule out of `styles.css`, because jsdom has no layout.

**Services are shown in AniList's own order**, not re-sorted to a favourites
list. Re-ranking them would be editorialising on no evidence, and the cap is
what actually decides which four appear.

**A failed lookup leaves `streams` undefined rather than empty**, so the next
visit asks again — the same rule as a failed synopsis fetch, a failed
catalogue fetch and a failed ratings fetch. "No listing found" is reserved for
the case where AniList answered and had none. Both states are checked.

**The region toggle went with it.** It existed only to choose between TMDB's
US and Canadian listings; AniList's links are not per-country, so there is
nothing left for it to pick. `wanx:region` is no longer written, and the
privacy page no longer lists a region among the things kept in your browser.

Gone with it: `tm` and `wp` on every entry, the `providers` table,
`watchUpdated`, `add-watch-providers.mjs`, the TMDB half of `add-one.mjs`, and
the `.tmdb-key` requirement. The catalogue dropped 76 KB, from 1.15 MB to
1.08 MB, and `npm run walks` came out byte-identical.

### The wordmark borrows the joke, not the brand

Build 43. The multicolour wordmark over a search box is a deliberate nod to a
certain search page, and it should stay that way — it says what this site is
before you read a word.

**But two of its six colours were that company's registered brand hexes
verbatim**: `#4285F4` and `#34A853`, in their exact order, over a centred
search box with two buttons under it. Each of those on its own is nothing; the
combination is the part that stops being a pastiche and starts being a copy.

**Copyright was never the risk and it is worth being clear why.** Colours are
not copyrightable and neither is a sequence of them — there is no original
expression in "blue, red, yellow, blue, green, red". The real question is
trademark, which is about whether anyone might infer an affiliation, and the
honest answer is that the practical risk was very low. It was changed because
the fix costs nothing, not because a letter was expected.

The blue moved to `#2f7fd6` and the green to `#1f9d55`. They read the same at
a glance, and both actually gained contrast on the light theme. **The yellow
and the red were already their own values** — `#f5b301` against `#FBBC05`, and
the site accent against `#EA4335` — so they stayed, and the red stays tied to
`--accent` so it tracks the rest of the site. A check asserts the two brand
hexes never come back, and a second one asserts all six letters still have a
colour, so the first cannot be satisfied by the palette quietly vanishing.

**The first version of that check passed for the wrong reason**, which is the
`empty-tier` lesson wearing new clothes. It built its pattern with
`new RegExp(\`color:\s*${h}\`)` inside a heredoc, the heredoc halved the
backslashes, and `\s` in a template literal is just `s` — so the pattern was
`color:s*#4285f4`, matched nothing, and reported a clean palette while the
brand hexes were still in the file. Both checks now do plain string work with
no escapes at all, and the guard was broken on purpose and watched to name the
offending hex. Comments are stripped first, because the stylesheet mentions
both old values in the note explaining why they moved.

**The yellow moved in build 44, and it is the one colour that cannot be the
same in both themes.** At `#f5b301` it scored **1.85:1** on white, failing even
the 3:1 large-text bar — but that same value is 9.59:1 on the dark theme and
looks right there, and darkening it far enough to pass on white would dull the
theme most people actually see.

So it became `--wordmark-yellow`: **`#c98000` on light (3.20:1)** and the
original `#f5b301` on dark (9.59:1), using the variable-override block the
stylesheet already had. Nothing else changed — the dark theme is byte for byte
what it was.

All six colours now sit between **3.20 and 4.10** on white, which is a tight
enough band that the wordmark reads as one palette rather than one letter
shouting. Three checks compute the ratios from the stylesheet rather than
trusting an eyeball, so a future palette tweak cannot quietly drop below the
bar; the light-theme one was broken on purpose and reported `1.85:1`.

### The accent behind white text is its own colour

Build 49, and it is the build 44 lesson finding the place build 44 did not
look. That build computed the wordmark's contrast ratios from the stylesheet
rather than trusting an eyeball, and fixed a yellow scoring 1.85:1. **It never
checked the controls.**

Every switched-on toggle chip — the direction toggle, the axis toggle and the
"2010 or later" year chip, all of which share `.direction` — is white text on
`--accent`. Measured in a real browser:

| Theme | Accent | White on it |
| --- | --- | --- |
| Light | `#e5484d` | **3.91:1** |
| Dark | `#ff6b6b` | **2.78:1** |

The bar for text under 18.66px is 4.5:1, and those chips are 12-13px. Both
themes failed, the dark one badly.

**The fix is a separate variable rather than a new accent**, and that is the
whole design. `--accent` carries the wordmark's red, whose contrast was tuned
in build 44 to sit in a 3.20-4.10 band with the other five letters — moving it
would silently retune the wordmark and break checks that have nothing to do
with buttons. `--accent-fill` does one job: the background under white text.

**`#d03e49`, and it is the same value in both themes**, which is worth stating
because the rest of this stylesheet overrides everything per theme. It only
ever sits under white, and white does not change between themes, so the page
background behind it cannot change what the colour needs to be. It is 4.70:1
against white, 4.70:1 against the light page and 3.78:1 against the dark one,
so the chip stays visible as a chip in both.

**It was searched for rather than picked.** The requirement is 4.5:1 on white,
at least 3:1 against both page backgrounds, and as close to the shipped
`#e5484d` as possible — a weighted-RGB distance over every red in range. A
hue-locked search was tried first and returned `#df2026` and `#ef0000`, which
pass and look like a fire alarm; letting saturation move as well as lightness
gives something a viewer would struggle to tell from the old one.

Six checks compute the ratios from `styles.css`, and two were broken on purpose
to watch them fail. **The one that matters is the last**: it asserts the rule
actually says `var(--accent-fill)`. Pointing the variable at a passing colour
while the rule still read `var(--accent)` satisfies every other check in the
block and changes nothing on the page — the same shape as the `empty-tier`
guard that passed with the guard deleted.

### The wordmark was splitting mid-word on most phones

Build 54, and it had been doing it since the wordmark was written. At 390px the
top of the page read **"whatanimeshouldiwatchnex / t"**.

`font-size: clamp(28px, 7vw, 54px)` looks like it scales with the screen, and
it does — but `#search-view` takes **20px of padding either side**, so the room
is `100vw - 40px` while the wordmark is a flat **12.797 times its own font size
wide**. Set those equal and `7vw` only fits above **384px**. Everything below
that overflowed and `word-break: break-word` did the rest:

| Width | Room | Biggest that fits | It was using |
| --- | --- | --- | --- |
| 320 | 280px | 21.9px | 28px |
| 360 | 320px | 25.0px | 28px |
| 375 | 335px | 26.2px | 28px |
| 390 | 350px | 27.3px | 28px |
| 414 | 374px | 29.2px | 29.0px ✓ |

**The 28px floor made it worse rather than causing it, and that matters because
lowering the floor is the obvious fix.** At 390px `7vw` is 27.3 and the floor
rounds it back up to 28 — but 27.3 *was already the exact limit*. Removing the
floor entirely fixes none of those four widths.

So the size is `min(calc((100vw - 40px) / 13.6), 54px)` — the room divided by
the ratio, which makes the fit exact by construction rather than by a constant
that happens to work. **13.6 rather than the measured 12.797 leaves about 6%
for the font stack**: this was measured in Segoe UI, and Inter, SF and Roboto
all set it differently. `word-break` stays as the last resort, so a face wider
than any of those wraps rather than overflowing — which is what it already did
everywhere, so this cannot read worse than before at any width.

The cost is that the wordmark is 5-8% smaller on phones: 28px to 25.7px at
390px, 29px to 27.5px at 414px. Desktop is untouched at the 54px cap. One line
is worth more than two points of size.

Five checks read the numbers back out of the rule and do the arithmetic the
browser would, since jsdom has no layout — including one asserting the headroom
is still there, because a divisor tightened back to the measured ratio passes
every other check and quietly re-breaks the fix on any machine with a wider
font. All five were broken on purpose: the old rule, the padding dropped from
the `calc`, and the divisor cut to 12.797.

**Found in a screenshot, like most real bugs here** — of a TikTok clip, not of
the site.

### Saying nothing when there is nothing to say

Build 42, three small ones found by looking at the live pages rather than the
tests.

**The housekeeping links lost their underline**, keeping it on hover. They sit
directly beneath the two buttons the page exists for, and underlined in the
accent colour they were the third-loudest thing on the screen. The colour is
enough to say "clickable".

**"Remove my ratings" hid itself only after this.** Clear already had the rule
— hidden until the watched list has something in it — and the button that
reaches the server to withdraw something you contributed did not. A first-time
visitor was being offered the deletion of data they had never given, in the
accent colour, directly under the two buttons they were meant to press.

**"? episodes" read as broken data.** A missing count means the show is still
airing, which the cell immediately beside it already says. Every other unknown
on that row renders as an em-dash, so this one does now too. The estimate
`lengthOf` makes for the demotion rule is deliberately *not* shown — it is a
guess for ordering, not a fact about the show.

**The studio tooltip said "Animation studio".** The name is clipped at 15ch to
keep the stat row from wrapping, so the tooltip was the only place the full
name could survive — and it was spending itself repeating the label underneath.
It now carries the name.

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

**And a walk that merely lost a few has to say so too.** That is the common
case, and the page was silent about it until build 36: the count existed and
was read in exactly one place, the branch that runs when the list emptied the
walk completely. Logged in, GATE: Jieitai returns Slayers — because Moonlit
Fantasy, Drifters, Berserk: Ougon Jidai-hen and Juuni Kokuki are all already
watched. That is correct, and with nothing on the card to explain it, it reads
as the matcher being broken. Found by the owner clicking through the live site,
and it cost a round of debugging the page could have answered in one line.

**Not "closer matches", which is what the working note first proposed.** Of
GATE's four skips only Moonlit Fantasy is nearer than the Slayers it served;
the other three are better matches that lost on distance. The honest claim is
that they matched and you have seen them, not that they were nearer — and the
wrong sentence would have shipped straight out of the note if the distances had
not been checked first.

It sits below the card with the other explanatory notes, and a check asserts
that placement rather than trusting it: a note appearing above moves the card
and every button in it, and this one appears exactly when the result changed in
a way worth reading about.

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

### The recommend row

Build 37, and it is the visible half of stage two: what other people said, and
the ask, in one row between the streaming line and the buttons.

**One row holding both, not two rows.** The figure arrives from `/api/ratings`
after the card is already on screen and has four possible states — nothing, a
count, a percentage, and nothing again if the request fails. Two separate
blocks could each appear and shove the buttons; one reserved block cannot
disagree with itself. Fixed `height: 30px`, not a minimum, the same trick as
`.synopsis`. It is in the card-shape check alongside the banner, the streaming
row, the trailer slot and the synopsis.

**Inside the card, unlike the explanatory notes.** Those sit below `.hero`
because they are conditional and appear exactly when the result changed. This
one is unconditional, so it can live where it is relevant.

**The figure is quiet until it has something to say.** At zero votes it says
nothing at all — "no ratings yet" on every card of an empty database is noise,
and the ask sitting beside it already implies it. Between 1 and the floor it
reports the count ("3 ratings so far"), never a percentage. At or above the
floor it says "82% would recommend · 147 ratings". The floor comes from the
server so it can move without a deploy of the page.

**Voting is optimistic.** The buttons and the figure update on click and the
request goes out behind them: a rating is not worth making anyone wait for, and
losing one to a dropped connection matters less than a card that feels stuck.
The answer is kept in `wanx:myvotes:v1` so the buttons still show it on the way
back, and so clicking the same answer twice costs no request at all.

**Ratings are fetched for the next twenty as well as the one on screen.**
"Show me another" walks the list, so one request makes every later card instant
at no extra cost — and the edge cache means most of those requests never reach
the database.

**A failed request is never cached**, the same rule as a failed synopsis fetch
and a failed catalogue fetch. The row keeps its height and stays quiet, and the
next card retries rather than inheriting the failure. Checks cover all of it,
including that the buttons still work when ratings are unavailable — which is
the state every title is in until somebody rates it.

### The ratings row is seeded from MyAnimeList

Build 51, and it answers the question the whole vote backend was stuck on.

**A percentage needs 30 ratings, across 4,427 titles — that is over 130,000
ratings before the row says anything on most cards.** This file has said for
several builds that "the machinery is finished; the numbers now need people".
MyAnimeList already has those numbers: 928,582 people scored Frieren alone.

#### The official API does not expose the histogram, and Tenrai does

`statistics` on MyAnimeList's own API gives the **status** breakdown —
watching, completed, on-hold, dropped, plan-to-watch — which is already stored
as `stats` and is what the "Kept watching" axis climbs. It does **not** give
the score distribution. That was checked rather than assumed: asking for
`score_distribution`, `scores`, `statistics{scores}` and `score_stats` all
return the default fields silently, because unknown field names are ignored
rather than rejected.

[Tenrai](https://tenrai.org/) is an unofficial REST mirror that does expose it,
at `/v1/anime/<id>/statistics`. **Its status counts match the official API's
digit for digit**, which is the check that it is the same underlying data
rather than a divergent set.

`add-mal-scores.mjs` harvests it, resuming from `mal-scores.jsonl` if
interrupted. About **19 minutes for the catalogue** at 4 requests a second,
which is the rate limit measured rather than guessed — the ninth request in a
burst comes back 429. Jikan, the better-known mirror, is roughly four times
slower and was returning 504s at the time.

**The dependency is bounded by being build-time.** Tenrai is a community
project funded through Patreon and could disappear. The numbers are baked into
`anime.json`, so if it does the site keeps serving the last snapshot and
nothing breaks — the same shape of dependency as the catalogue itself, and
nothing like a runtime one.

#### MyAnimeList's displayed score is not the mean of its own histogram

Worth knowing before trusting either number, and found by accident: the
arithmetic mean of Frieren's histogram is **8.98**, while the site displays
**9.25**. That gap is not rounding, and it is not their weighted-score formula
either — at 928,000 votes the weighting is negligible. Across six top-ranked
titles the gap tracks the size of the 1-star tail almost monotonically:

| | MAL shows | Histogram mean | Gap | 1-star share |
| --- | --- | --- | --- | --- |
| Frieren | 9.25 | 8.98 | **0.27** | 3.15% |
| FMA: Brotherhood | 9.11 | 8.97 | 0.14 | 2.17% |
| Kaguya-sama S3 | 8.95 | 8.85 | 0.10 | 1.54% |
| Steins;Gate | 9.07 | 8.96 | 0.11 | 0.71% |
| Shingeki S3 P2 | 9.05 | 9.03 | **0.02** | 0.76% |
| Hunter x Hunter | 9.03 | 8.96 | 0.07 | 0.37% |

**They are filtering votes out of the displayed score, and filtering more the
more a title has been bombed.** Trimming Frieren's 1-star tail to a quiet 0.1%
and recomputing gives **9.23** — essentially their published 9.25, which is
what identified what the filtering is doing.

So the two numbers answer different questions. The histogram is what people
typed; the published mean is what people typed after some were thrown out.
**This site computes from the histogram**, which makes its figure the less
filtered of the two. That is a defensible thing to be, and it is stated on the
card by naming the source.

#### When the two MyAnimeList numbers disagree, the card says nothing

The stats page and the published score do not always describe the same votes.
**"How Dare You!?" is rank 769 with a mean of 7.99, and 11,625 of its 13,100
votes sit on exactly 6** — a mass rating MyAnimeList evidently drops from the
score while still showing it in the breakdown. Computing from the histogram
gives **11% would recommend** for a well-regarded show.

Only **5 of 4,427** entries diverge by more than a point, so this is rare — but
each of those five would be conspicuously wrong on a card, and a figure nobody
can stand behind is worse than a blank space. When the histogram mean and
MyAnimeList's own score disagree by more than 1.0, no figure is shown. Same
instinct as the vote floor, and self-healing: if a later harvest finds them
agreeing, the figure returns on its own.

#### And a needle is not a distribution — the mean cannot see one

Build 53. The divergence rule above compares the histogram's **mean** against
MyAnimeList's published score. That is the right test for a review bomb, which
drags the mean until the two numbers visibly disagree. **It is close to blind
to a spike parked on a middling score**, because a needle at 6 barely moves a
mean while costing every one of those votes on a yes/no threshold at 7.

Measured across the catalogue: **23 entries have one score holding 40% or more
of their votes, and 19 of them pass the divergence rule.** The worst was
showing on cards:

| | Histogram | MAL agrees? | Card said |
| --- | --- | --- | --- |
| Mushen Ji | **92% on exactly 8** | yes, to 0.26 | **99% would recommend** |
| Shanhe Jian Xin | 79% on exactly 7 | yes, to 0.60 | 96% |
| Hug tto! Precure | 73% on exactly 8 | yes, to 0.03 | 93% |
| Capeta | 52% on exactly 6 | yes, to 0.91 | 44% |

Mushen Ji's full histogram is `[3,0,1,1,2,3,11,919,31,31]` — three per mille on
either side of the spike. Nobody produced that by watching a show.

**Two conditions, and both are load-bearing.** `SPIKE_RATIO` (2.5) is the
evidence a bucket is artificial: how far out of line it sits with its immediate
neighbours. `SPIKE_SHARE` (0.15) is whether it is big enough to matter.

Each alone fails, and both failures were seen before the thresholds were fixed:

- **Ratio alone fires on noise.** Little Witch Academia has a bucket 3.1x its
  neighbours holding **3.7%** of the vote — a bump in the low tail of a
  perfectly healthy curve, moving the figure by nothing. It would have blanked
  a 358,000-scorer title for no reason.
- **Share alone fires on agreement.** A broad smooth peak holding 30% with 20%
  either side is what a well-liked show looks like.

**Only scores 2-9 are examined, and excluding 1 and 10 is policy rather than an
oversight.** A spike at 1 is a review bomb, and the section above counts those
on purpose. A spike at 10 is acclaim — **Frieren has 53% of its votes on 10 and
Steel Ball Run 73%**, both at the end of a smooth ramp. Examining the endpoints
blanks the best-regarded shows on the site, which is exactly what happened when
the loop was broken to `0..9` on purpose: Steel Ball Run, the review-bomb check
and the just-above-the-floor check all failed together.

**15 entries are caught, 0.30% of the catalogue; 12 of them the divergence rule
missed, so 0.24% of cards lose a figure. None is in the top 200.** Six checks
cover it and all six were broken on purpose — removing the call printed
`{"pct":99,"scorers":13157}`, which is the Mushen Ji bug itself.

`npm run walks` came out **byte-identical**, which here is the proof rather
than a formality: this is a display rule and it must not be able to reach the
matcher.

**The threshold came from the distribution, not from taste.** The needle ratio
across the catalogue has a median of 1.22 and a 99th percentile of 1.88; every
title that must not be touched — Frieren, FMA:B, Koe no Katachi, Hunter x
Hunter, Steel Ball Run — sits **below 0.8**. There is a wide empty band between
the healthy shows and the artefacts, the same shape of gap the length-mismatch
threshold was chosen on.

#### Review bombs are counted, deliberately

Somebody who rates a show 1 out of spite still would not recommend it, and
"% would recommend" measures sentiment rather than merit. Deciding whose
opinion counts is not this site's job — and MyAnimeList has already made that
call once, in the other direction.

#### 5 and 6 were tried as neutral, and the data said no

This is the part worth keeping, because the idea is obviously right and is
measurably wrong.

MyAnimeList labels 5 "Average" and 6 "Fine". Neither is a recommendation, so
dropping them from the denominator — counting only 7-10 as yes against 1-4 as
no — looked like the honest reading, and it shipped that way for an afternoon.

**Then it was measured across all 4,427 titles:**

| Rule | p10 | median | p90 | IQR | share ≥ 90% |
| --- | --- | --- | --- | --- | --- |
| 7+ yes, **1-6 no** | 47% | **64%** | 84% | 22 | **4%** |
| 7+ yes, **5-6 neutral** | 76% | **89%** | 97% | 13 | **46%** |
| 7+ yes, 6 neutral only | 61% | 78% | 93% | 20 | 18% |

**The neutral band puts the median show at 89% and nearly half the catalogue
above 90%.** The figure stops discriminating, which for a number meant to help
somebody choose is the whole job gone.

The cause is an asymmetry that is easy to miss: **people who dislike a show
mostly drop it without scoring it.** So the 1-4 tail is thin — thinner than the
number of people who actually disliked the thing. Removing 5 and 6 compares a
fat "yes" against an artificially thin "no", and mediocre shows come out
looking excellent. That is the one failure that actively misleads.

So nothing is excluded: **7 and above is a recommendation, everything else is
not.** A 6 is "Fine", and somebody who thought a show was fine would not tell a
friend to watch it — the maths and the words agree. The median title reads 64%,
and the spread runs from Frieren at 94% down to 41% at the bottom of the
catalogue.

**`RECOMMEND_AT` (7) lives in `app.js` for the histogram and in
`functions/api/_shared.js` for the site's own imported scores, and a check
asserts they agree** — the card can show both figures at once, and two numbers
on one row computed by different rules would be worse than either alone. It
stays a read-time decision on both sides, which is the rule `schema.sql`
already sets out, and is what made trying the neutral band cheap enough to
find out it was wrong.

#### Stored as shares, and why that is still the raw signal

`sd` is ten integers, tenths of a percent per score, lowest first; `sv` is the
true number of scorers. The raw counts run to six digits each and would add
about 20% to the file every visitor downloads; shares cost a third of that.

**The shape survives, which is the property that matters.** A stored "% would
recommend" would be smaller still and is exactly the mistake `schema.sql`
warns against: a stored verdict can only be retuned by asking everyone again.
Shares keep the threshold a read-time decision.

#### What the card says

> 94% would recommend · 929k on MyAnimeList

**Named as MyAnimeList's, always.** It is not this site's community speaking,
and presenting borrowed numbers as your own is the kind of thing that is
noticed exactly once. Naming the source also makes the figure stronger rather
than weaker: 929,000 people is a claim this site will not be able to make for
years.

The site's own figure joins it once it clears the floor —
`94% would recommend · 929k on MyAnimeList · 82% here (147)`. Below the floor
it is not shown at all: "3 ratings so far" beside a figure built on 929,000 is
noise, and it was only ever worth saying when the row would otherwise be empty.

The row keeps its fixed 30px height and the figure keeps `nowrap` with an
ellipsis, so a longer string is clipped rather than allowed to wrap — the
constant-height rule the card is built on. Checks assert both.

**One word is dropped below 400px, and only one.** Measured in a browser: the
row leaves 229px for the figure there and the full sentence needs 242, so the
ellipsis would eat "MyAnimeList" — the one part that must survive, because a
borrowed figure with its attribution cut off is the dishonest version. The
percentage, the count and the source are all load-bearing; `would` is the only
word that can go without losing a fact, and without it the line fits in 207.
It is wrapped in `.figure-would` and hidden by the existing 400px block. Three
checks cover the mechanism, since jsdom has no layout to measure.


### Sharing an imported list

Build 38, and it is the part that decides whether any of the rest matters. The
floor is 30 ratings before a percentage appears, across 4,427 titles — that is
more than a hundred thousand ratings, and nobody is clicking thumbs a hundred
thousand times. One MyAnimeList export routinely carries several hundred scored
titles. Everything else in stage two is machinery waiting for this.

`parseExport` already walked every `<anime>` node reading the id and the
status. `<my_score>` was in the same node, ignored.

**Zero means "not rated", not "terrible."** MyAnimeList writes 0 for every
unscored entry. Counting those as 0/10 would drag every figure on the site
toward the floor while looking like genuine opinions. Only 1-10 is kept.

**Only titles in the catalogue are kept.** A real list is mostly films, sequels
and specials this site does not carry. Sending them wastes requests and — worse
— overstates what someone is being asked to contribute.

**The question is asked after the file is parsed, never before.** By then the
export has been read entirely on the visitor's own machine and nothing has been
sent, so the offer can name the real number. "312 scored titles" is checkable
against your own file in a way that "help improve recommendations" is not.

**Unticked, and asked again every time.** A remembered yes is a decision
somebody made once and then stopped being aware of, which is the thing consent
is meant to prevent.

**Declining costs nothing, and the wording says so.** The watched list is
already saved either way. A refusal that breaks something is not a refusal.

**What is not sent is stated at the same size as what is.** Shrinking that half
is how a consent box quietly becomes dishonest, so a check asserts both halves
are present.

Uploads chunk at 100. That is the client half of the server's `MAX_BATCH`, and
both exist for the free tier's 10ms CPU budget rather than for tidiness. A
whole list takes a few seconds, so it reports progress — a button that sits
there looking broken is worse than a slow one that says what it is doing. A
failure stops rather than hammering the endpoint, and says how much got
through, because that is more use than a bare failure.

### Importing by username

Build 50. **Type a MyAnimeList username instead of finding a file.** The export
route asks somebody to log in, find the export page, generate a `.xml.gz`,
download it and then locate it in a file picker — four steps on somebody else's
site before they reach this one, and it is where most people give up. The
username route is one field.

**It needs a server, and that is the only reason `/api/mal-list` exists.**
MyAnimeList will serve a *public* list to anyone holding a client id — no
OAuth, no user token, confirmed by calling it — but that id is a build-time
credential, gitignored, and putting it in `app.js` would publish it to every
visitor. The Function forwards a username and slims the answer; it adds nothing
else.

**One manual step, and until it happens the feature is switched off rather than
broken.** `MAL_CLIENT_ID` has to be set as an environment variable on the Pages
project — Workers & Pages → the project → Settings → Variables and Secrets, as
a **Secret**, for Production and Preview. Without it the endpoint answers 200
with `unavailable: true` and the page says *"Username import is not switched on
yet — use the file import below"*, which is the designed resting state and the
same shape as the votes database being unbound.

**One page per request, and the client loops.** The free tier allows 10ms of
CPU per request and `JSON.parse` on a few megabytes of list data will not fit —
MyAnimeList returns the full node for every entry whatever `fields` asks for,
so a large list is megabytes. `PAGE` is 500 and the client follows `next`,
reporting progress as it goes. Exactly the reasoning that makes the ratings
upload chunk at 100.

Rows come back as `[[id, status, score], ...]` rather than objects: three
numbers a row instead of three keys and three numbers, which matters at 5,000
titles.

**The two upstream failures are told apart, because the remedy differs.** A 404
is "no MyAnimeList user called *name*"; a 403 is "that list is private, make it
public or use the file import". Reporting a private list as "not found" would
send somebody hunting for a typo that is not there.

**A malformed username never reaches MyAnimeList.** The name is checked against
`^[A-Za-z0-9_-]{2,16}$` before any upstream call, so a bad one costs no quota
and nothing can be smuggled into the URL path. A check asserts the upstream was
not called.

#### A Function that throws answers with nothing you can read

Worth writing down because it cost two rounds of deploying to work out, and it
will happen again to whatever endpoint is written next.

With the secret set but **malformed**, `/api/mal-list` answered:

```
HTTP/2 502
content-type: text/plain
server: cloudflare

error code: 502
```

No JSON, no message, and nothing naming the endpoint — because that is
Cloudflare's own edge error, not anything the Function wrote. **From outside it
is indistinguishable from the Function not being deployed at all.**

What isolated it was that every response returning *before* the upstream call
was fine — a bad username still gave a proper 400 — so the Function was
running, and only the path through `fetch` was dying.

Two things came out of it, and both are worth keeping:

- **The handler is wrapped.** `onRequestGet` is a try/catch around the real
  work, so no path can reach the edge as an unhandled throw. Whatever breaks,
  the page gets JSON it can show.
- **The credential is trimmed and checked.** A header value containing a
  newline is not a bad request, it is a thrown `TypeError`. Every build script
  in this repo already reads `.mal-client-id` with `.trim()`, which was the
  clue. It is now also validated as alphanumeric, and a value that fails says
  *"The MyAnimeList credential on this server is malformed"* — which is what
  finally identified the real fault, a stray character added while pasting into
  the dashboard.

**The general rule: a Pages Function should never be able to throw.** The
failure mode is not a stack trace somewhere, it is an opaque 502 that looks
like a deployment problem.

#### The two importers share everything except where the rows came from

`readListRows` returns the identical `{ ids, planned, scored }` shape as
`parseExport`, and `applyImport` is the single place either one is acted on. So
what counts as watched, what the count sentence says, and when consent is asked
are decided once for both. Plan-to-watch is excluded and a score of 0 means
"not rated" on both routes, because those rules live in one place.

**The one thing that cannot be shared is the status vocabulary, and it is the
part most likely to rot.** The export XML and the API spell the same four
concepts differently — `On-Hold` against `on_hold` — so there are two sets,
deliberately declared next to each other. **The failure if they drift is
silent**: an unrecognised status is treated as plan-to-watch, so the title
stays recommendable and the import merely looks like it skipped things. A check
covers it, and breaking it on purpose reports zero titles recognised and all
five counted as plan-to-watch.

#### It changed what the privacy page has to say

Until now the honest claim was that an import is read entirely on your own
machine and never leaves it. That is still true of the file, and **the file
importer stays for exactly that reason** — it is the route for somebody who
would rather send nothing at all.

A username does not: it goes to this site's server, which asks MyAnimeList. So
the privacy page now names three things that leave the device rather than two,
says the username is used for one request and not stored or tied to the random
id, and points at the file import as the alternative. Shrinking that admission
is how a privacy page quietly becomes dishonest.

### Taking it back

`DELETE /api/vote` removes everything one voter id has said. It exists because
the consent screen promises it, and that promise is what makes the rest of the
screen credible.

It works in bites of 100 and reports what is left, and the page keeps calling
until nothing is — the same CPU budget that forces the upload to chunk, from
the other end. The loop is bounded, so a server that kept claiming work
remained could not spin forever.

**It is a separate button from Clear.** Clearing the watched list is local and
instant; removing ratings reaches the server and withdraws something you
contributed. Rolling them into one would mean people tidying their list
silently withdrew their ratings too.

**Its limit is stated rather than hidden.** The only handle on a person's
ratings is the random id in their browser, so clearing browsing data makes them
genuinely unreachable — by them, by me, by anyone. That is what being properly
anonymous costs, and the privacy note says so in those words rather than
implying a recall that does not exist.

### The privacy note

`privacy.html`, linked from the credit line and from the consent screen. Plain
prose, the site's own stylesheet, no separate design to drift out of step.

It exists because **build 38 is the first time anything leaves the visitor's
machine.** Until now the whole story was "nothing is uploaded, no cookies,
nothing to consent to", and that was true — the analytics are cookieless and
the import was read locally and never sent. A page that collects nothing needs
no privacy note; the moment that changes, it does.

It is deliberately specific about the third parties, which is the part most
sites omit: the browser fetches posters from MyAnimeList's CDN and synopses
from AniList on every card, so those companies see visitor IPs. Trailer embeds
use `youtube-nocookie`. Saying so costs nothing and leaving it out would make
the rest less believable.

Checks assert the page covers what is stored, what is sent, how to take it
back, the limit of taking it back, who else sees an IP, and where to ask — and
that it stays crawlable, unlike every other file in the repo root, because a
page describing what is collected is no use if it cannot be found.

### The tip jar

Built in build 41, **launched in build 49**. The credit line now reads:

> Rankings from MyAnimeList · genres from AniList · Privacy · Buy me a
> coffee · build 49

**The eight builds it spent switched off were the point, not a delay.**
r/anime's "Do Not Sell Things" rule bans advertising crowdfunding, and the
announcement post is a one-shot — so a live donate link on the page when that
post went up would have risked the one attempt at the audience. The post went
out on 27 August 2026 with the site unambiguously non-commercial, and this
followed it. **If there is ever another launch of this kind, that is the
ordering: the post first, the ask afterwards.**

With `TIP_JAR_URL` empty *nothing renders at all*, which is how it shipped for
those eight builds and is still true — emptying the string is the whole of
turning it off again, and a check boots a patched copy to prove that rather
than trusting it.

**It sits in the credit line, which exists only on the landing view.** That
makes "the card cannot move to accommodate it" structural rather than a matter
of styling — there is no card on that screen. The cost is that somebody
arriving on a shared `/?id=N` link never sees it, which is the right trade:
this project has moved a card under somebody's cursor once too often already.

**The build marker stays last.** The link is inserted ahead of it, because the
footer build number is the first thing to check when a result looks wrong and
it should stay where it is looked for.

**Nobody needed to be asked.** MyAnimeList's API agreement defines
non-commercial as "personal, educational, open source or communal" and permits
*"donations without any quotas"*. TMDB was the one that counted donations as
possibly commercial, and it stopped being a dependency in build 40 — which is
what unblocked this, and why the two jobs were queued in that order.

**The Ko-fi page exists and is live**: `ko-fi.com/whatanimeshouldiwatchnext`,
set to CAD, paying out through Stripe, with "Get all of Ko-fi" **off** — that
toggle trades 5% of every tip for supporter-only posts and custom colours,
none of which this uses, and 0% on tips was the whole reason for choosing
Ko-fi. Stripe Radar is on the free Lite tier and Stripe Tax is off.

**So nothing is left to build or set up. What remains is a decision**, taken
deliberately and not yet taken: the owner asked to hold the launch rather than
ship it the moment it worked. Launching is pasting that URL into
`TIP_JAR_URL`, bumping the build, and pushing.

**Nothing is given in return for a tip, and that is deliberate.** The site is
identical whether or not you pay; there are no supporter-only posts and no
perks. That keeps a tip a gift rather than a sale, which is the distinction
deciding whether GST is a question at all — and is a second reason "Get all of
Ko-fi" stays off.

## The vote backend

**Live.** `/api/ratings` answers with real counts rather than
`unavailable: true`, which is how to tell from outside that the database is
bound — call it and look for that flag:

```bash
curl -s "https://whatanimeshouldiwatchnext.com/api/ratings?ids=1"
```

The two steps that got it there, kept because they have to be repeated if the
project is ever rebuilt, and neither can be done from the repo:

1. Create the database — `npx wrangler d1 create wanx-votes`, or the D1 page in
   the Cloudflare dashboard.
2. Bind it to the Pages project as **`VOTES`**: Workers & Pages → the project →
   Settings → Bindings → D1 database binding. The name in the code is
   `env.VOTES`, so the binding must be spelled exactly that.

Then apply the schema once:
`npx wrangler d1 execute wanx-votes --remote --file=./schema.sql`

**There is a third thing to set, for a different endpoint.** `/api/mal-list`
needs `MAL_CLIENT_ID` as a **Secret** under Settings → Variables and Secrets,
for Production and Preview. Without it username import answers 200 with
`unavailable: true` and the page says so; the file import is unaffected,
because it needs no server at all. See "Importing by username" above.

### Two tables, and the split is the whole cost story

`votes` holds one row per person per title and is touched only when somebody
votes. `ratings` holds one row per title and is what every card view reads.

**Computing a percentage by scanning `votes` at read time would cost one row
read per vote, per card view.** A title with 5,000 votes would cost 5,000 reads
every time it appeared; D1's free allowance is 5 million reads a day, so a few
hundred visitors would exhaust it. Reading one pre-aggregated row costs 1. That
single choice is the difference between free forever and a bill, and a check
asserts the read path never says `FROM votes`.

The response is cached at the edge for five minutes on top of that, so most
card views never reach the database at all. Ratings move slowly — a title needs
30 votes before it shows a number — so a stale figure is harmless.

### The raw signal is stored, never the verdict

A thumb gives yes/no; an import gives a score of 1-10. Both are kept as they
arrived. `RECOMMEND_AT` (7) is applied at *read* time, so "what counts as a
recommendation" can be retuned with a one-line change — where a stored verdict
could only be retuned by asking everyone again.

The aggregate is a **histogram** (`s1`..`s10`, `up`, `down`) rather than a
yes/total pair for the same reason: any threshold is computable from that one
row, so moving to 8 needs no migration. The read costs the same either way.

Thumbs and imported scores **pool** into one figure, because far more titles
clear the 30-vote floor that way and that is the entire point of importing.
They stay separate in the row, so splitting them later needs no new data.

### What the free tier actually constrains

100,000 requests a day, and **10ms of CPU per request**. A single indexed query
is nowhere near it; inserting several hundred rows from an import in one go
could be. Hence `MAX_BATCH` (100) and `MAX_IDS` (40) — those caps are about the
CPU budget, not tidiness, and the client has to chunk a large import.

### `_routes.json` keeps the rest of the site static

`{"include": ["/api/*"]}`. Without it Pages puts a Function in front of every
request on the site, including `index.html` and the 1.18 MB catalogue. With it,
everything except `/api/` is served exactly as it was.

### An unrouted method falls through to the SPA

Pages routes a method only if something handles it. Without a HEAD handler,
`HEAD /api/ratings` answered **200 with `index.html`** — a web page, from a
JSON endpoint. Harmless for the site, which only ever sends GET, but anything
monitoring the endpoint would be told it was healthy by a page that knows
nothing about it. Found by calling the deployed endpoint rather than by reading
the code, which is the same way most real bugs here get found.

`/api/vote` has one `onRequest` that dispatches, rather than an `onRequestPost`
plus a catch-all: exporting both leaves it ambiguous which Pages prefers, and
that is not worth depending on.

### It has to degrade to today's site

Same rule as a failed catalogue fetch, one level down: if the database is
missing or falls over, `/api/ratings` returns 200 with `unavailable: true` and
the page carries on without ratings. The site worked without them yesterday and
must keep working without them today. A check asserts that path exists.

### Tested against real SQLite, not mocked

D1 is SQLite and Node ships SQLite, so `npm test` applies `schema.sql` verbatim
to an in-memory database and runs the exact upserts the endpoint issues — no
new dependency, `node:sqlite` is built in. That covers the case worth covering:
**changing your vote has to move the count out of the old bucket as well as
into the new one.** Missing that decrement is the classic aggregate bug, where
the total drifts upward and never comes back, and it is invisible until the
numbers are already wrong. A check compares the aggregate against a scan of the
raw votes and fails if they disagree.

Compiled with `npx wrangler pages functions build` and exercised with
`wrangler pages dev` before shipping, which is the same toolchain Cloudflare
runs — worth doing, because a Functions build failure fails the whole
deployment, and that would take the site down rather than just the endpoints.

## Maintenance

| Task | Cadence | Time |
| --- | --- | --- |
| `npm run build` | once a season | **~2.5 hours** |
| `node add-anilist-tags.mjs` | rarely — tags drift slowly | ~3 min |
| `node add-mal-scores.mjs` | after a rebuild, or when the figures feel stale | ~19 min |
| `node backfill-genres.mjs` | after a rebuild only if it reports blanks | ~10 s |

**A rebuild is one step now.** It used to be two: the builder carried no
provider data, so `add-watch-providers.mjs` had to run straight afterwards or
the site shipped with zero listings, and the catalogue was not release-ready
in between. Build 40 moved streaming to a page-view lookup, so a rebuild is
finished when the builder is, and that whole class of half-built catalogue is
gone.

AniList tags and genre backfill happen inside the builder's art pass, so a
rebuild carries them already — `add-anilist-tags.mjs` and `backfill-genres.mjs`
exist for fixing an existing catalogue without paying the 60 minutes.

**Long builds must run detached**, or a Claude Code crash takes them with it:

```bash
powershell -c "Start-Process node -ArgumentList 'build-catalogue.mjs','--depth','10000' -WorkingDirectory $PWD -RedirectStandardOutput 'rebuild.log' -WindowStyle Hidden"
```

The builder only writes at the very end, so an interrupted run loses progress
but never corrupts the existing catalogue.

---

## Open

**All three queued jobs are done**, builds 39 to 41. They are struck through
below with what shipped, because the reasoning behind each is still the record
of why it was done that way.

**One thing is queued**, below. Everything else outstanding is a decision or a
thing only a human can do, listed at the end of this section.

### 1. The mood entry point, and the leaderboards that fall out of it

**Not started.** "Surprise me" covers having no preference; nothing covers
having a direction but no title. Somebody who fancies *a slow-burn
psychological thriller* cannot start using this site at all.

The plan, and the appeal is that it carries **no matcher risk**: offer the
genres and the signature themes — both already counted at load — let somebody
pick one, choose a well-ranked entry carrying it as the anchor, then run the
existing walk completely unchanged.

**Each mood also becomes a prerendered page**, which is the long-tail SEO play
aimed at people who do not yet have a title in mind — the half of the audience
`/anime/<id>/<slug>` cannot reach.

#### It should show a leaderboard, and that is a global ranking done right

A **global** "% would recommend" table was considered and rejected, and the
measurement is why. Ranking all 5,012 entries with a figure by percent
recommend and comparing that to MyAnimeList's own rank gives a Spearman
correlation of **0.979** — the same list with the furniture moved. That is
arithmetic rather than laziness: both numbers are built from the same votes.
The page would duplicate one MyAnimeList already owns and will always outrank.

**It would also not mirror AniList, because AniList's scores are not stored.**
Only MyAnimeList histograms are in `anime.json`, so calling such a page "global
rankings" would overclaim.

**And a leaderboard sorts by the corrupted number, which is what makes the
spike rule a prerequisite rather than a nicety.** A card shows one title at a
time, so the odds of meeting one of 15 artefacts are low; a table sorted by the
metric floats every one of them to the top. Before build 53 the first row would
have been Mushen Ji at 99%.

**The per-mood version has none of those problems.** "Highest % would recommend
in Psychological" is not a table MyAnimeList publishes, it targets *"best
psychological anime"* rather than *"anime rankings"* — a query this site can
actually win — and the mood page has to compute that list anyway to pick its
anchor. Showing it is nearly free.



~~**1. A year filter.**~~ Shipped in build 39 — see "The year filter" above.
One chip reading "2010 or later", riding in the existing toggle row at no
vertical cost, measured at 360, 375, 414 and 1280px. If 2000+ versus 2015+ is
ever wanted, that is a second chip, not a redesign.

~~**2. Drop TMDB as the streaming source.**~~ Shipped in build 40 — see
"Where to watch" above. AniList's `externalLinks` was confirmed working first
(the 403 had cleared), and it covers 69% against TMDB's 50% while costing no
extra request, since the card was already fetching the synopsis. The region
toggle, `tm`/`wp`, the `providers` table, `add-watch-providers.mjs` and the
`.tmdb-key` requirement all went with it.

~~**3. The tip jar.**~~ Built in build 41, **launched in build 49** — see
"The tip jar" below. It was held until the r/anime post had gone up, because
that sub bans advertising crowdfunding and the announcement is a one-shot.

~~**1. A single genre means neither demotion can fire.**~~ Fixed in build 47 —
see "When there is no tier to demote into" above.

### Not code

**The search side is finished and needs nothing further.**

- Google Search Console: verified as a **Domain property**, sitemap submitted,
  reading **Success at 3,464 URLs** (4,381 after build 48; resubmit is not
  needed, Google re-reads the sitemap on its own). It first showed "Couldn't fetch" and
  resolved itself — Googlebot had not actually attempted the fetch yet, which
  was confirmed by fetching as Googlebot (200, right content type, no BOM)
  rather than guessing.
- **A Domain property can only be verified by DNS**, so the HTML-file and
  meta-tag methods do not exist for it and there is no second method to add.
  Do not go looking for one. The protection is simply never deleting that TXT
  record, and re-adding it if DNS ever moves.
- Bing Webmaster Tools: imported from Search Console, which also covers
  **DuckDuckGo, Yahoo and Ecosia** — those take Bing's index and have no
  console of their own.
- Cloudflare **Crawler Hints** is on. It pings IndexNow when content changes,
  which suits a site that regenerates 4,379 pages per rebuild. Bing family
  only; Google does not participate.

**What is left is people, and none of it is code.**

- ~~**The tip jar is built and switched off.**~~ Launched in build 49, after
  the r/anime post, at `ko-fi.com/whatanimeshouldiwatchnext`. Turning it off
  again is emptying `TIP_JAR_URL`, and a check asserts that still works.
- **r/anime allows this, and the rules were read rather than assumed.**
  Anime-related tools and websites "can be announced when they're released".
  Three gates, in the order they bite: **10 comment karma earned in r/anime**
  before you can post at all; the **"Do Not Sell Things" rule bans advertising
  crowdfunding**, which is why the tip jar stays off until after the post; and
  the announcement is a **one-shot** — minor updates are not allowed, major
  functionality changes are case-by-case. Flair **Misc.** (there is no tool
  flair and the rest are text-only or industry news), title of four or more
  words, no link shorteners. Do not lead on the MAL rankings: posts *about*
  database aggregate ratings are prohibited, and the tool merely uses them.
- **Show HN** is the other post worth making, in a completely different
  register — plain and factual, where the Reddit one is casual.

### What the owner found by posting it

**It was posted to r/anime on 27 August 2026**, flaired Misc., titled "I built
a website to help you find your next anime", with the tip jar still switched
off so the "Do Not Sell Things" rule could not bite. The announcement is a
one-shot, so there is no second attempt.

**Two things came back that were worth more than the vote count.**

**A stranger found a real bug within hours** — the one written up under "A card
you have already been shown never comes back" above. That is the first defect
here found by somebody with no stake in the project, and it was a good report:
exact reproduction steps, and a correct diagnosis ("anything in the chain is an
implicit rejection"). Worth remembering the next time the question is whether
more features or more people would be the better use of a week.

**The privacy claim in the draft was wrong, and checking it before posting is
what caught it.** The post said "I'm not collecting anything about you", which
is false: Cloudflare Web Analytics runs on every page, and `/api/vote` is live
and storing ratings against a random id. It was replaced with the specific
version — cookieless counts, a random id, no name or email, and a link to the
privacy page. **Specific claims read as more trustworthy than a blanket one**,
because readers assume the blanket one is a lie.

**Vote counts on a new post tell you nothing**, and it is worth writing that
down before the next launch. Reddit fuzzes displayed scores deliberately as
anti-manipulation, so the number is not real; /new has habitual downvoters who
hit anything that looks like self-promotion without reading it; and one
downvote is nothing algorithmically next to comments. **Never delete and
repost** — that trades a slow post for no post, plus a spam signal, and burns
the one-shot.


Shared to a Discord community, and the first real feedback loop produced two
things worth keeping.

**"It doesn't work well with GOAT anime" is the wrong diagnosis, and the right
one is already in this file.** Walking *up* from a top-ranked show runs out of
things above it — Mushoku Tensei is #309 and exactly one of the 161 isekai in
the catalogue ranks higher. The walk is not failing, it is correctly reporting
that there is nowhere up to go, and it flips direction and says so. The useful
line for a reader is **"if you type something highly ranked, hit Ranked
lower"** — a tip rather than a caveat.

**A heavily-watched account filters a great deal, and the card says so
correctly.** With a full MyAnimeList import loaded, Mushoku Tensei reported
**"366 shows that matched are already on your watched list, so they were
skipped"**, which is the entire explanation for results feeling thin. That
number is only trustworthy because of the build 39 fix: before it, the counter
counted everything the scan walked past rather than everything that matched,
and would have reported most of the list while meaning nothing. Working as
designed, and arguably a selling point rather than a caveat.

---

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

**Exempting a jumped candidate from the frontier was the third idea, and it
was tried and reverted too.** The reasoning was sound: in both failures above
the damage is not the reorder, it is that a jumped-forward candidate *advances
the high-water mark* and monotonicity then deletes everything behind it. So let
a candidate that came forward on affinity be shown without moving the mark.

**Exempting every reorder removes the climb altogether.** `preferLocally`
shuffles neighbours constantly over tiny affinity differences, so almost
nothing advanced the mark and almost nothing was filtered. Backtracks fell from
18 to 4, which looks like success and is monotonicity switching off — the
sawtooth simply moved out of the labelled tail and into the middle of the
chain, where nothing explains it. Ame to Kimi to went 2049, 1968, **2039**,
1900, **2001**; Chihayafuru lost Nana, Shigatsu wa Kimi no Uso and Rurouni
Kenshin and gained **Planetes**, a space drama.

**Restricting it to leaps over 100 positions is far better behaved** — only
three anchors moved, and Berserk's Fullmetal Alchemist stopped being
mislabelled a backtrack. Paired with the +2 theme bonus it even fixes GATE
properly, pulling Drifters in while *keeping* Slayers, Dragon Quest and
Claymore rather than deleting them.

**But it still costs more than it earns.** Overlord loses Log Horizon, its best
result. Re:Zero still loses Evangelion, Madoka, Houseki no Kuni and Tian Guan
Cifu — because the entry *after* the jump advances the mark instead. Toradora
loses three, Ame to Kimi to wanders. **The exemption stops the jumping entry
from deleting what it leapt over; it cannot stop the next one doing the same
thing.** It moves the problem one position down the chain rather than removing
it, which is why there is no fourth version of this idea worth writing.

Build 34 fixed GATE a different way — by scaling the reach with the anchor's
position — without touching monotonicity at all. That is the one that shipped.

**Mushoku Tensei is unchanged, and that is the rule working.** Its genres are
Adventure, Drama, Ecchi and Fantasy — four, one of them rare — so nothing above
it shares all four and its top tier is *empty*. Promotion never creates an
empty tier, so the rule correctly declines to fire. Fixing this anchor means
promoting into nothing, which is the Arslan Senki failure. Leave it.

**And the deeper reason it never opens on isekai is that it has nowhere to
go.** Mushoku Tensei is #309, and **1 of the 161 isekai in the catalogue ranks
above it** — Guimi Zhi Zhu, and that is the whole list. 2 of the 66
Reincarnation entries do. Walking *up* from one of the best-regarded isekai on
the site, there is nothing left of its own kind to find; "Ranked lower" is the
useful direction for an anchor near the top of its genre. Worth remembering
before treating a thin chain here as a bug.

**It also loses its best thematic match by a single position, which is worth
recording as the shape of the proximity/affinity tension.** Mo Dao Zu Shi is 33
away and shares three genres *and* Reincarnation. Berserk is 62 away, shares
three genres and no theme, and carries one more point of affinity. Jumping
ahead needed 29 positions of reach and the budget at Mushoku's rank is exactly
30, so Berserk went first by one position — and then advanced the high-water
mark past Mo Dao Zu Shi, dropping it into the backtrack tail. Nothing here is
misbehaving; the margin is simply one position wide.

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

~~**A very long series is still recommended to a very short one.**~~ Fixed in
build 35 — see "And a 220-episode series is demoted against a 12-episode one"
above. The original note is kept below because the measurement in it is what
the threshold was chosen against.

**The measurement it was chosen against**, kept because the threshold came
from it. GATE: Jieitai is 12 episodes, and its fifth result was
Naruto at 220. Nothing is misbehaving: Naruto shares all three of GATE's
genres, which is an exact match as far as the matcher is concerned, and it sits
283 places away — four behind Juuni Kokuki. It arrives in proper proximity
order in the top tier.

What the matcher never looks at is **length**. This is the same shape as the
case that justified demoting `Kids`: "a 12-episode dark isekai recommends
Pokémon — 276 episodes, same three genres, 48 places away". Pokémon is caught
because it is Kids; Naruto is Shounen, so nothing catches it. And GATE has no
demographic recorded at all, so that tie-breaker cannot fire either — by
design, a missing demographic is never a penalty.

Measured: 46% of short anchors (≤26 episodes, with genres) have a 100+ episode
*full* genre match within 300 places. Treat that as the ceiling on exposure,
not the rate of bad results — most are buried by affinity, and GATE's Naruto
still only surfaced fifth. The sharper number is that only **100 of 3,493
entries have 100+ episodes**, and being high-ranked and genre-broad they sit
near everything: Ginga Eiyuu Densetsu, Gintama, Hunter x Hunter and Naruto turn
up against Bocchi the Rock, Cyberpunk: Edgerunners and Violet Evergarden alike.

**The fix to try is a length-mismatch demotion built exactly like the Kids one**
— a tier down, so it surfaces once closer-sized matches are exhausted.

**It must be a ratio against the anchor, not an episode count**, because
sometimes a long series is exactly right: Haikyuu!! legitimately reaches Slam
Dunk, Hajime no Ippo, Touch and Diamond no Ace, and a blunt penalty would
wreck that chain. Haikyuu (25 ep) to Hajime no Ippo (75) is 3x; GATE (12) to
Naruto (220) is 18x. That gap is wide enough to separate them — wider than
anything separating the cases that defeated the affinity work above, which is
the reason to think this one is tractable.

~~**A tip jar — "buy me a coffee" or similar.**~~ Built in build 41, not
launched — see "The tip jar" above. The reasoning is kept below because the
registrations were read rather than assumed, and this file had them wrong in
both directions before.

**MyAnimeList is fine with it, explicitly.** The API agreement defines
non-commercial as "personal, educational, open source or communal" and says
such applications may accept *"donations without any quotas"*. It also allows
non-commercial apps *"some pay per click or pay per view advertising"* provided
it does not disrupt the experience and complies with law — so the old note here
was **too strict** about ads.

~~**TMDB is the one to be careful with.**~~ Moot since build 40: TMDB is no
longer a dependency. Kept because it is the reason this job sat behind the
streaming work, and because the terms are worth remembering if TMDB is ever
reached for again. Its licence "does not permit any commercial use", and
commercial explicitly covered advertising revenue and *"indirect monetization
through traffic generation"*:

> Even unpaid activities like donations or volunteer projects may be considered
> commercial if they generate revenue indirectly.

So a donate link was *not* obviously outside their definition, which is the
opposite of what this file once claimed — and their own guidance was to ask
them about the specific case, with commercial use needing "a separate written
agreement". Dropping the dependency was the cheaper answer than the email.

Practically it is one link in the footer next to the credit line. The card must
not move to accommodate it, so it belongs outside `.hero` with the other
explanatory notes.

~~**The voting system.**~~ All three stages shipped, builds 32 to 38: "have you
watched it" → "would you recommend it", a % recommend rating, and MyAnimeList
list import. It was the only part of the original idea needing a backend, and
it now has one.

- ~~**Stage 1: remember what you have watched.**~~ Shipped in build 32. Local
  only, no server. See "The watched list" above.
- ~~**Stage 2: the votes themselves.**~~ Anonymous — a random id in local storage,
  no accounts. Ratings need votes, not identities, and holding strangers'
  credentials is a responsibility this project should not take on. Cloudflare
  already hosts the site, so Pages Functions plus D1 keeps it on one platform.
  Shipped in builds 36 and 37 — see "The vote backend" and "The recommend row"
  above.
  **It cannot be made abuse-proof without accounts, and that is permanent.**
  Clearing local storage earns a fresh id. Rate limiting raises the cost, it
  does not close the door. The numbers should keep reading as soft rather than
  as survey data, and nothing should ever be built on top of them that assumes
  otherwise.
- ~~**Stage 3: imported lists feeding the ratings.**~~ Shipped in build 38 —
  see "Sharing an imported list" above. Roughly 133,000 ratings are needed for
  meaningful per-title percentages (30 across 4,427 titles), which is why the
  import matters: a few hundred uploads does what millions of pageviews would.
  **What is left is nobody knowing the site exists.** The machinery is done;
  the numbers now need people.

~~**A percentage needs a floor before it is shown.**~~ Shipped: `VOTE_FLOOR`
is 30, the server sends it so it can move without a deploy of the page, and
below it the card reports a bare count instead. "100% would recommend" from one
vote looks like data and is not.

**The row is no longer empty while it waits, and that is build 51.** Thirty
ratings across 4,427 titles is still over 130,000 before this site's *own*
figures mean anything, and no amount of further code supplies that. But the
question the row asks — would people recommend this — is already answered by
MyAnimeList for every title, and it now shows that answer, named as theirs,
until its own numbers arrive. See "The ratings row is seeded from
MyAnimeList" above.

So the honest position is narrower than it was: what needs people is the
site's own community figure, not the row itself.

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
- **Seed `localStorage` before the app script boots, not after.** `app.js`
  reads the watched list, the format filter and the year chip into module
  scope on load, so a test that sets them after `makeDom` runs on the
  defaults — and then passes whatever it was meant to catch. A check written
  this way passed with the bug it targeted reinstated. `makeDom` takes
  `seedWatched` and `seedModern` for exactly this.
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
