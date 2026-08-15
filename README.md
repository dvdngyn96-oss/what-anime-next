# whatanimeshouldiwatchnext

A blank, Google-style page. Type an anime you've already watched, and it walks
up the MyAnimeList rankings to the next one that shares its genres.

Static site — no build step, no server, no runtime API calls.

## Run it

```bash
python -m http.server 8777 --directory "C:\Users\David\Downloads\what-anime-next"
```

Then open <http://localhost:8777>.

## What's in the catalogue

Only things you can start watching cold:

- **TV series only** — no films, OVAs, ONAs, specials or TV specials
- **First seasons only** — anything with a prequel is dropped

So you never get handed a season 2, a recap special, or part three of a film
trilogy. The builder scans the top 8,000 by MAL rank and keeps what survives
both filters.

Sequels are detected from MAL's own `related_anime` data — if an entry has a
`prequel` relation, it's out. That's authoritative rather than guesswork, and it
catches the cases titles don't advertise. A title-pattern check (`2nd Season`,
`Part 2`, `R2`, trailing roman numerals) runs first as a cheap pre-filter and a
backstop for entries whose relation data can't be fetched.

## How it works

The site runs off `anime.json`, a local catalogue ordered by **MyAnimeList
rank**. Because the whole ranking sits on the client, the recommendation is
literal rather than approximate:

1. Find your anime's row in the ranking.
2. Step one position at a time toward rank #1.
3. Return the first entries that share its genres.

That's the actual "next one up the list" — not "something with a similar score".

Worked example — **Tokyo Ravens**, ranked #2658, genres Action / Fantasy /
Romance, themes School / Urban Fantasy:

| Rank | Climb | Title |
| --- | --- | --- |
| #2619 | +39 | Zero no Tsukaima F |
| #2599 | +59 | Rakudai Kishi no Cavalry |
| #2517 | +141 | Shakugan no Shana |

Search is local too, so autocomplete is instant — no API, no rate limits,
nothing that can go down.

### Genres decide, demographic and themes break ties

MAL's API merges genres, themes and demographics into one list. The builder
splits them. **Genres** (Action / Fantasy / Romance) decide whether something
matches at all — requiring every theme to line up too would be so strict that
nothing ever would.

**Demographic** (Shounen, Seinen, Shoujo, Josei, Kids) and **themes** (School,
Urban Fantasy, Isekai) then order the matches, via a single affinity score:

```
affinity = shared themes + (same demographic ? 2 : 0)
```

Demographic is weighted higher because Shounen versus Josei is a wider gap than
School versus Adult Cast. It only counts when **both** sides declare one — a
missing demographic scores zero, never a penalty. That matters: only 41% of the
catalogue has one, against 79% for themes. A source with no demographic behaves
exactly as it did before, falling back to rank order.

Matching themes and demographics are outlined on the result, so you can see why
it was chosen. The effect is substantial — for anchors that have a demographic,
it changes the top recommendation **52% of the time**:

| Anchor | Genres + themes | Adding demographic |
| --- | --- | --- |
| Hunter x Hunter *(Shounen)* | Berserk | **One Piece** |
| Rainbow *(Seinen)* | Attack on Titan | **Monster** |
| Slam Dunk *(Shounen)* | Uma Musume | **Hajime no Ippo** |
| Saiki Kusuo *(Shounen)* | Grand Blue | **Gintama** |
| Toradora! *(no demographic)* | Chihayafuru | Chihayafuru *(unchanged)* |

### Badges

**Hidden gem** — well rated, but comparatively few people have watched it.
Thresholds come from the catalogue's own distribution (bottom 40% by members,
top 40% by score) rather than fixed numbers, so it keeps working as rankings
shift. About 8% of entries qualify.

**Currently airing** — still going out, so there's more to come.

### Match quality beats direction

Walking up is the default, but a weak match upward is worse than a strong match
downward. The order of preference is:

1. every genre shared, in the direction you asked for
2. every genre shared, the other way
3. all but one, in the direction you asked for
4. all but one, the other way
5. any overlap, either way

Steins;Gate (#5) is the clearest case. Nothing above it shares Drama / Sci-Fi /
Suspense — only Fullmetal Alchemist and Frieren, on the strength of "Drama"
alone. Just below sit Evangelion, Shinsekai yori and Gankutsuou, sharing all
three. It walks down and says so.

### Everything anchors to your original pick

Results are always matched against the anime you searched for, never against
the last thing shown. Chaining off each result instead makes it drift — the
seventh suggestion ends up having nothing to do with where you started.

**Seen it too — drop it** removes an entry and re-runs against the same anchor,
so the attribution line never changes:

> Steins;Gate → Evangelion → Shinsekai yori → Gankutsuou →
> Serial Experiments Lain → Texhnolyze → Inuyashiki

**Start from this instead** is the explicit way to re-anchor. A fresh search
clears the dismissals; if everything nearby has been dismissed, it forgets
rather than dead-ending.

**Show me another** steps through the matches without dismissing anything.

### The climb never goes backwards

Criteria loosen as the walk runs out of matches — first the demographic, then
themes, then genres. Crucially, **loosening does not restart the walk**: it
carries on from where it got to. Offering something worse-ranked *and* a weaker
match than what you were just shown is worse on both counts, so it never does.

Himekishi wa Barbaroi no Yome (#5198, Adventure / Comedy / Fantasy, Shounen):

| Rank | Match |
| --- | --- |
| 5069 → 2768 | all 3 genres + Shounen |
| 2456 → 2229 | all 3 genres *(demographic ran out — climb continues)* |
| 5210 → … | walks down, having exhausted everything above |

Each loosening says what it dropped. The rank only ever moves backwards once,
when the climb is genuinely exhausted and the walk turns around — and that is
labelled too. The "others" grid shows peers of the entry on screen.

Entries the climb passed over aren't discarded: they're swept into one
continuous run at the end, so the list stays long without re-introducing a
sawtooth.

### Searching something outside the catalogue

If you've watched a film, an OVA or a season 3 and want to use it as your
starting point, search still works: it falls back to AniList (no key needed),
slots the result into the ranking by score, and saves it to `localStorage`.

Those live entries are **starting points only** — they've not been checked for
being a film or a sequel, so they're never offered as recommendations. What you
search is unrestricted; what you get back is always a TV first season.

### Match tiers

If nothing further up the list matches every genre, it relaxes and says so:

| Tier | Meaning |
| --- | --- |
| exact | shares every genre |
| close | shares all but one (only when the source has 3+ genres) |
| loose | shares at least one |

### Filtered out

- Sequels, OVAs and specials from the same franchise (normalised title prefix)
- `Music` entries
- The 101 entries (2%) MAL lists with no genres at all — mostly recaps

## Rebuilding the catalogue

```bash
node build-catalogue.mjs
```

Pulls rank, score, genres, themes, titles and posters from MyAnimeList's
official API — 500 entries per request, so the whole catalogue is ten calls and
about ten seconds. Writes `anime.json` (~850 KB).

Once a season is a good cadence. Nothing breaks if it's stale: new shows need
months of votes before they rank meaningfully, and existing entries drift only a
few positions.

### Credentials

The builder needs a MAL client ID, read from `MAL_CLIENT_ID` or from a local
`.mal-client-id` file. That file is gitignored and is **only** used at build
time — the shipped site contains no credentials and makes no MAL API calls.

Get one at <https://myanimelist.net/apiconfig> (App type: other, non-commercial).

## Other bits

- Results are deep-linkable: `?id=16011&dir=up`
- **Ranked higher / lower** walks the list in either direction
- **Show me another** steps through the matches
- **I've seen this one too** pivots onto the recommendation
- **Surprise me** picks a random anime from the catalogue
- Synopses are fetched lazily from AniList for the shown title only
- Titles are searchable in both romaji and English
- Light and dark themes follow the OS setting
