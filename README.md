# BlessedBets

A basketball and football tool for deciding which props and parlays are worth betting, built
around the apps in your rotation: PrizePicks, Underdog, Sleeper, Real and Winible for pick'em, FanDuel
as the one sportsbook, and ProphetX and Polymarket.

Sportsbook bets and parlays are only ever recommended at FanDuel. Pinnacle, BetOnline, LowVig,
DraftKings and the rest are pulled to price the market and never shown as the place to bet.
Add a book under Settings if you open an account there.

Two tabs: **NBA** and **NFL**, with the NBA the one the board is built for. **College football
rides inside the NFL tab**, off by default: turn the switch on under Settings → Today and one press
pulls both, each priced with its own numbers, with a college row badged CFB wherever it appears.
On PropLine that is six more requests of the daily 1,000; on The Odds API it takes the press from 56
credits to 80, and the button asks before spending it. Each tab keeps its own cached pull, so
switching never throws away a slate you already paid for.

The NHL was removed. Nothing pulls or prices it; a logged NHL entry still reads back off a
screenshot and still settles, because its stats are hockey's and a read that forgot that would
silently type them as basketball.

**It does not create an edge. It stops you acting on edges that are not there.**

That is the whole design brief. A projection built from season averages, compared against a
line the market has already priced, will happily report a fifteen percent edge that is
entirely an artefact of a thin input. This app refuses to produce that number.

Five things:

1. **Refuses to price what it cannot verify.** A prop with no sportsbook price behind it is
   marked unpriced, shown for context, and excluded from every expected-value calculation
   and from the optimizer. No exceptions.
2. **Captures the payout off your screen.** Stored payout tables drift. The multiplier the
   app displays while you build the entry is ground truth, so you read it in and confirm it
   before anything is priced, and it is stored with the slip.
3. **Prints the break-even hit rate beside every expected value.** If the break-even does
   not look like a plausible per-leg number, the multiplier is wrong and the expected value
   beside it is fiction.
4. **Shops the line and models correlation.** The same opinion is worth more on the app with
   the better number, and same-game legs are not independent.
5. **Keeps you honest.** Logs what the model predicted against what happened. This is the
   only part that can tell you the model is wrong.

Everything runs in your browser. No account, no database, no telemetry.

**It now measures what a pull cost rather than estimating it.** The Odds API states the cost of
every request in a response header this app used to throw away. Those are summed, and the figure
shown under Games is the feed's own, not a forecast — with the estimate named as an estimate when
the feed does not itemise. When the feed bills *less* than was estimated, that is the app's own
long-standing open question ("does a market that comes back empty still cost a credit?") answering
itself, and it says so. The comparison is against the estimate for the requests that actually
completed, so one failed game cannot read as an answer. A request that reports no cost counts as
unmeasured, never as free: the total is then called a floor rather than quoted as a sum.

**Two feeds can price the slate, and PropLine is the default.**
[PropLine](https://prop-line.com) bills per request against 1,000 a day — one per game whatever
the market list, so width is free and a full NBA night is 16 requests — and carries the lines
**PrizePicks and Underdog are actually posting**, which is what a pick'em entry has to be built
at. [The Odds API](https://the-odds-api.com) is the sharper of the two and the only one carrying
Pinnacle's player props, but it bills per market per game against 500 credits a month: a full NBA
night at five markets is 70, about seven presses. So PropLine pulls the slate every night and The
Odds API answers "what does Pinnacle say about this one prop". Pick the provider under
Settings → Odds feed. A PropLine key also works alongside The Odds API: Pinnacle prices the
props, PropLine supplies the pick'em apps' lines, and the pick'em entry is built at the line your
app shows.

What PropLine costs is Pinnacle: it carries no Pinnacle player props, so the sharp reference
behind a prop there is BetOnline and LowVig, and those count as one book. That is why **Require
sharp reference** stays on, and why a prop no market maker priced is held to the lesser of the
consensus and the retail books' own number.

## Running it

**Node 22 or newer is required.** Check with `node -v`; if it says v20 or lower, install the
current LTS from [nodejs.org](https://nodejs.org) (or `nvm install 22`, since `.nvmrc` pins it).
Node 20 reached end of life in April 2026 and no longer gets security fixes, so npm is set to
stop with an `EBADENGINE` error rather than install on it.

```bash
git clone https://github.com/kingbobbywhite-blip/blessedbets.git
cd blessedbets
npm ci
npm run dev
```

Open **http://localhost:3000**, pick a league tab, and press **Get today's picks**.

`npm ci` installs exactly the versions in `package-lock.json`, the ones CI has checked, and
never rewrites that file. `npm audit` should report 0 vulnerabilities.

The dev server only answers on this computer (127.0.0.1). It holds any key in `.env.local`,
so other devices on your Wi-Fi are kept out. To open it from your phone on the same network
anyway, start it with `npx next dev -H 0.0.0.0`, and only on a network you trust.

### Updating an existing clone

```bash
git pull origin main
npm ci
npm run dev
```

The repository was renamed from `wagerwise` to `blessedbets`. A clone made before that keeps
pulling and pushing, because GitHub forwards the old name, but it is worth pointing it at the
new one so nothing depends on the forwarding:

```bash
git remote set-url origin https://github.com/kingbobbywhite-blip/blessedbets.git
```

If a pull aborts with "Your local changes to the following files would be overwritten" and
names `package-lock.json`, an `npm install` rewrote it. Nothing in it is worth keeping, so
discard it and retry:

```bash
git checkout -- package-lock.json && git pull origin main
```

If `npm ci` reports packages that are not in `package.json` (Supabase, for example), or
anything else odd, the `node_modules` directory is stale. Wipe and reinstall:

```bash
rm -rf node_modules && npm ci
```

### Deploying

`main` is the production branch. With Vercel's Git integration connected, every push to
`main` deploys itself; otherwise deploy by hand from a clone:

```bash
npx vercel --prod
```

**The deployment is private.** Vercel Authentication is on for *All Deployments*, so every
page and every API route answers a visitor who is not logged into this Vercel team with a
redirect to Vercel's login, and nothing else. *Standard* protection is not enough here, and
this was checked rather than assumed: it protects each deployment's generated URL but treats
the addresses under the project's Domains — including the production `*.vercel.app` one — as
public, and with it on, the production URL still served the full app and its API to anyone.
To use the app you sign into Vercel once in that browser; on a phone, that includes the
home-screen app.

Even so, leave `ODDS_API_KEY` and `PROPLINE_API_KEY` unset in Vercel and enter the keys in
Settings, which keeps them in your own browser. Protection is a setting someone can turn off;
a key that was never on the server cannot leak from it.

The feed routes only answer JSON requests from the app's own pages, so another website open
in your browser cannot spend a key held in `.env.local` through your local server.

**Every response carries security headers** (`next.config.mjs`). The one that matters most
is the Content Security Policy's `connect-src 'self'` and `img-src 'self'`: the feed keys
live in this browser's storage, and under this policy even a script that somehow got onto
the page could not send one anywhere, because the browser may only talk to this origin — and
the page never needs to, since every feed call goes through this app's own server routes.
The policy was checked against every page, the picks worker and a real OCR run with no
violations, and against a deliberate attempt to send data off-site, which it blocked. Pages
cannot be framed by another site, the browser is told to deny camera, microphone and
location, and the framework does not announce itself in a header.

### The API key

The app needs sportsbook prices. Get a key from [prop-line.com](https://prop-line.com) (free,
1,000 requests a day). That is the default feed and the one to get first: it bills one request
per game whatever the market list, so a full NBA night is 16 requests of the 1,000 and the whole
eleven-market board comes back for the price of four — and it carries the lines PrizePicks and
Underdog are really posting, which is what a pick'em entry has to be built at.

The simplest place for it is **Settings → Odds feed** in the running app: paste it there and
it is kept in your browser. To keep it in a file instead, copy the example file and put the
**real key** after the `=` in a text editor:

```bash
cp .env.example .env.local        # Windows: copy .env.example .env.local
```

Restart the app after editing `.env.local` so it picks the key up; a key there takes
precedence over one in Settings. Avoid `echo KEY=... > .env.local` in Windows
PowerShell 5: it writes the file as UTF-16, and the key in it is never read. Without a
working key the app has no prices, and it will say so rather than invent an edge.

Optionally add an [Odds API](https://the-odds-api.com) key (free tier: 500 requests a
month) as well. It is the sharper of the two and the only feed here carrying **Pinnacle's**
player props, which dominate a consensus by design — but it bills per market per game, so a full
NBA night at five markets is 70 of the 500, about seven presses. Keep it for a Pinnacle read on a
prop you are about to bet rather than for pulling a slate every night. It goes in the same
Settings tab, or on the `ODDS_API_KEY=` line of `.env.local`.

With one key set the app selects that feed on first run; with both, PropLine. Nothing moves a
phone onto a feed it has no key for.

The same caution about public deployments applies: leave `PROPLINE_API_KEY` unset on an
unprotected URL and enter the key in Settings instead.

**"PropLine rejected the API key"** means PropLine received a key and did not recognise it,
so the fix is the key itself, not the app. The message names where the key it sent came
from. Three things cause it:

- The key is wrong, revoked, or from somewhere else. Check it against the one on
  [prop-line.com](https://prop-line.com); an Odds API key is not a PropLine key, and the two
  fields in Settings are not interchangeable.
- `PROPLINE_API_KEY` in `.env.local` holds something stale, and it takes precedence over
  Settings, so retyping the key in Settings changes nothing. Correct it in the file, or
  delete the line and restart. A placeholder such as `your_api_key` is ignored rather than
  sent, so it can no longer shadow a real key in Settings.
- The key was pasted with a newline or wrapping quotes. Those are stripped now, but the
  PowerShell 5 UTF-16 trap above still applies.

```bash
npm test         # 745 unit tests over the probability engine, the feeds and screenshot reading
npm run lint
npm run build
```

## What you get, every day

Pick a league, press one button, and the app pulls today's games, prices every player prop
it can, and produces three things:

**Best single bets.** Offers where one book is priced better than the sharp consensus of
the others. The book being judged is always excluded from the consensus that judges it,
and at least one market-making book has to remain, otherwise a room full of copycats
becomes its own reference. Each row shows the price, the fair price, the edge and a
stake sized by fractional Kelly.

**Best parlays.** Built only from legs that are individually positive expected value and
at least as likely to hit as not, and only within a single book, because a leg at DraftKings
cannot be combined with a leg at FanDuel onto one ticket. Correlation between legs is priced
rather than ignored.

**Pick'em entry.** The likeliest targets that clear the bar: one leg per player, at most two
per game, with the chance they all hit and the expected return at your default app's payout
table. If too few clear, it says so rather than padding the entry with coin flips.

**Every line on the card is the app's own, or none of them is.** An entry is built at your
default app's real lines, read through PropLine, or at the books' lines when the pull carried
none of the app's — never at a mixture of the two. This is the one rule here worth stating on its
own, because the mixture is what it used to do: a target whose line never arrived went in at the
sportsbooks' number with a small grey label, on a card headed with the app's name and a payout
table whose expectation multiplies every leg's chance at the line beside it. The reasoning was
that a line we never heard about is not the same as one the app is not offering, which is true
and is still not a line anyone can place. In practice about half a card's lines were not the
app's, and nothing on the card told you which half.

So a prop with no line from the app is left out, whichever reason it has, and both reasons are
counted under the card: how many the app covers and is not posting, and how many its lines never
reached at all. They lead to different next steps — the first is not playable there, the second is
worth a look on your own screen — so they are never merged into one number. With no PropLine key
at all, the books' line is all there is, and the card says it is the number to go and look for
rather than one the app is known to be posting.

**Pick'em targets.** With a PropLine key, the lines PrizePicks and Underdog are posting are
listed under each player with the chance of each side, priced off the sportsbooks, and your
default app's line is filled in. The table leads with the chance at the line you can actually
play and names which line that is, so the app's number and the books' number are never shown as
one; where they differ, both appear. A line the app posted a while ago says how old it is, since
the apps move them and a stale reading is a guess about the present. Without a key, nothing here
can see what the apps are offering, so type in the line your app shows.

**How the books' line has moved.** Every pull records the books' consensus line for each prop,
and where an earlier pull saw the same game, the target row shows the move: *books 23.5 → 25
(▲1.5) 3h ago*. When your app's line still sits nearer where the books were than where they are,
the row adds *PrizePicks 23.5 is behind the move*. That is the shape of a stale line, which the
[limitations](docs/LIMITATIONS.md) name as the edge on these products that is actually real — a
number the operator has not moved yet. The chance on the row already prices the gap; the move
says why it is there, and that it may not stay. The line is the books' consensus, not the app's:
only the books are recorded, so "behind" describes where the app's line sits now, not whether it
ever moved. It needs two pulls of the same game, compares against the most recent earlier one,
and is anchored on the pull on screen, so it never presents the gap between two older pulls as
today's movement.

Either way you get one answer: the over, the under, or pass. Never both. Value bets likewise show
one side per player and stat: an over at one book and an under at another is a middle, not two
picks, and on a pick'em app one of the two always loses.

Nothing is fetched until you press the button, and the result is cached, because player
props are billed per market per game and a page refresh that silently re-pulls the slate
is a refresh that costs money.

## Getting more data in

The daily pull covers the common markets automatically. These paths exist for when you
want something it does not pull, or want to work off a DFS board directly.

### Your own screenshots

Screenshot the board on your phone and drop the images into **Capture**. OCR runs entirely
in this browser, using a bundled engine and language model, so nothing is uploaded and no
app is scraped. Scraping a pick'em app's endpoints violates their terms and gets accounts
restricted, and the board is the half that carries no information anyway: it tells you what
is on offer, not what it is worth.

Capture the fifteen or so props you would genuinely consider rather than the whole board.
Every row lands in a review table and has to be ticked off by eye before it can be loaded,
and a shorter list gets checked properly.

You can also paste CSV, TSV, JSON, or plain text copied off a board.

After reviewing the rows, press **Attach sportsbook odds** to price them. Props that get a
price become priced; everything else stays unpriced and cannot be built into an entry.

### Feed settings worth knowing

Put Pinnacle first in the book list and keep `eu` in the regions, because Pinnacle sits in
that region and leaving it out silently removes the most useful price on the board.

Player props are billed **per market per game**. Four markets across a twelve-game slate is
48 credits for one refresh, so the free tier is about ten refreshes a month. Narrow the
market list rather than the book list: books are free, markets are not.

Narrow the market list rather than the game cap, too. Games are the other factor of the bill, but
cutting them is not free in the way it looks: outside the depth-ranked college slate the cap takes
games in **start order**, so a lower cap drops the latest tip rather than the thinnest market. On
PropLine, which bills per request, a game costs one request of 1,000 a day and the cap should just
be the whole slate.

| Column (for pasted data) | Matters |
| --- | --- |
| `player`, `market`, `line` | Required. The line is the number your app is offering. |
| `book`, `over_odds`, `under_odds`, `book_line` | Without these the prop is unpriced. |
| `game_log`, `minutes_log` | Per-game values. Used only when no price exists. |
| `rest_days`, `teammates_out`, `projected_minutes` | Minutes context for the no-odds path. |
| `app`, `game_id`, `team`, `opponent` | Enables line shopping and same-game correlation. |

## The one number worth internalising

The per-leg hit rate you need just to break even, summed across every paying tier:

| Entry | Top pays | Break-even per leg | All-hit shortcut would say |
| --- | --- | --- | --- |
| Power 2-pick | 3x | 57.7% | 57.7% |
| Power 3-pick | 5.5x | 56.7% | 56.7% |
| Power 4-pick | 10x | 56.2% | 56.2% |
| Power 5-pick | 20x | 54.9% | 54.9% |
| Power 6-pick | 37.5x | 54.7% | 54.7% |
| Flex 3-pick | 2.25x | **59.1%** | 76.3% |
| Flex 4-pick | 5x | **56.9%** | 66.9% |
| Flex 5-pick | 10x | **54.3%** | 63.1% |
| Flex 6-pick | 25x | **54.2%** | 58.5% |

A 55% leg is a losing bet on most of these. "I hit 60% of my picks" is not the same as being
profitable, and a two-pick is the hardest of them all to beat.

These are standard picks. Goblins and demons change every tier: a real 6-pick flex of five
goblins and a demon hit five of six and paid **0.5x**, where the table above pays 2x. That is
why the tracker scores a logged entry at what the app actually paid, not at a table.

The right-hand column is what you get by raising the top multiplier to the power of minus
one over n, which is the shortcut almost every parlay calculator uses. It is correct for
all-or-nothing entries and wildly wrong for anything with partial-payout tiers, because it
ignores every dollar the lower tiers return. On a 3-pick flex it overstates the bar by
seventeen points, which is more than enough to talk you out of entries that are fine.

## Documentation

- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — how every number is computed.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — what this cannot do, and where it can
  mislead you. Read this one before betting real money.

## Legal and practical

Sports betting and daily fantasy are regulated differently in every jurisdiction and are
not legal everywhere. Payout tables shipped here are **unverified defaults** and change
without notice. Nothing here is financial advice, and no model makes a negative-expectation
market profitable by itself.

## A name is not an identity

Across 130 college teams, two different players sharing a normalised name in one slate is
ordinary rather than freakish. Every map in the app used to be keyed on the name alone, which
fused them: six books pooled into one consensus and a line that was wrong for both. Player
identity is now name **and game**, in the quote grouping, the one-decision-per-prop rule, the
optimizer's one-leg-per-player constraint, the board's row grouping and the pick'em entry. The
same name in two games is also no longer the same player to the correlation model, where it was
pricing two unrelated legs as one event.

The pick'em lines still match by name, because they arrive from a different feed than the prices
and the two spell teams differently — but a line from the same fixture wins, matched on team
nicknames, and when a name is shared and no line can be tied to the fixture, nothing is shown and
the row says why. An imported board carries a name and a stat with usually no fixture, so there
the ambiguity is reported rather than resolved.

## What gets left out, and why you can see it

Four things are kept out of the pick'em section, and every one of them is counted and nameable
on screen. A fifth — the entry's expected value — is withheld rather than left out, which is its
own entry below:

**Props too lopsided for a board.** A flat payout table only works if both sides of a pick are
plausible, so an app does not post a prop whose favoured side is a near-certainty however happily
a sportsbook prices one. The ceiling is a dial in Settings (default 80%), what it removes is
listed by name under the targets with the reason, and a line PropLine shows an app actually
posting is never removed by it.

**Lines no board shows.** The thresholds and the probability ladder cover the lines the books are
actually hanging, widened half a standard deviation, instead of sweeping a fixed window around the
projection — plus any **whole number** the books post, which the ladder used to be unable to
represent at all. A pick'em app posts x.5 most of the time and not always: a real settled entry
held "under 7 rebounds" and landed on exactly 7. That is neither a win nor a loss. The leg voids,
and on an all-or-nothing entry the entry shrinks to one fewer pick at a lower multiplier. Any line
that can do that now says how often it would, on the row where you type it.

**Props your app has no line for.** Once a pull carries your app's own lines, a target without one
is out of the entry, because an entry is never built at a line the app may not be posting. The
count under the card splits the two reasons apart: the app covers that game and market and is not
posting this prop, or its lines never reached the prop at all. Coverage is judged per market
rather than per game, because an app covering a game says nothing about which stats it covers in
it — PrizePicks will post points for every starter in a game and no rebounds line in it anywhere,
and keyed on the game alone every one of those rebounds props read as "offered, and this player is
not on it", which is a different claim from the truth. The props are still in the table below at
the books' line, to check against your screen.

**Pick'em lines nothing on the slate can price.** A line reaches a board row through one key, the
player and the market, so a PrizePicks rebounds line for a player the books priced only for points
can never attach to anything. Those are shed from what gets stored, and the count and the markets
are named, one clause per reason — a player the books ignore is a different fact from a market
they did not post, and a single sentence covering both says something false about one of them.

The filter stops short of the obvious rule, deliberately: a line is also the *evidence* that an
app covers a game and market, and that evidence is read for other players' rows. So a line is kept
when its own prop is priced **or** when its market is priced for anyone in its game. Drop the
second clause and the screen says "no PrizePicks line reached at all" about a game and market where
PrizePicks did post one and this app threw it away. Which apps turned up in a pull is counted
before any of this, because that question is about what arrived rather than what survived.

**A goblin or demon changes the multiplier for the whole entry, not for its leg.** So a standard
payout table cannot describe an entry that holds one, and the bar it produces errs low every time.
Four real settled Power Plays paid 8x, 8.5x, 4.5x and 3.75x where the stored tables said 10x, 10x,
6x and 6x — a per-leg break-even of 59-64% where the app was showing 55-56%, understating the
worst of them by **nine points**. Eight of those fourteen legs were goblins or demons. Whenever
your app is posting a flavoured line on the board, the bar is labelled a floor rather than the
bar, and the fix is on the same card: read the "$X for $Y" off your own entry screen and it
becomes the real bar, the expected value appears, and it is remembered for that app, mode and
entry size.

**PrizePicks varies the multiplier on standard entries too.** Two real Power Plays of three
standard picks, no goblins or demons, paid 6x and 5.5x. So the stored 3-pick is the lower of the
two, and below a payout you read in, the bar comes from your own logged entries: the lowest "if
every leg hits" payout among your last five logged entries of the same app, mode and size, of
standard picks only, wherever that is below the stored table. A leg has to clear the bar at the
payout the entry may actually get, and the heading on the entry card says which number the bar
is using.

**An under in the NBA has to clear a little more.** Unders have not worked as well in the NBA in
the experience of the person this is built for, and it came up over a 4-pick of four NBA unders.
Two hit. The two that missed were Jeremiah Fears at 13 assists against an under of 3.5, and
Donovan Clingan passing 10.5 points with four minutes left in a 21-point game. So Settings →
Odds feed carries a margin per league that an under has to clear on top of the bar: three points
in the NBA by default, none elsewhere. With the NBA margin a 56% bar asks 59% of an under and
still 56% of an over. The margin moves no probability, only which side is a pass. It can stop you
playing an under. It cannot make one look better than the market says. A row it holds back says
that is why, and the Today screen names the margin whenever it is in force. Two of four is not
evidence, and the three points are a prior, not a measurement. The tracker is where it gets tested.

**The tracker splits overs from unders, by league, against the bar they needed.** "NBA unders
2-2, needed 63%" says something that "Assists unders 1-1" and "Points unders 1-1" cannot. Each
row prints the per-leg rate its own entries had to hit to break even, because goblin-heavy entries
pay less and need more. A four-goblin 4-pick at "$10 for $40" is 4x, and every leg had to hit
70.7%. Where a league has both sides, the screen says whether the gap is bigger than luck makes
on those samples. The bar for that is twenty legs a side and two standard errors.

**A logged entry now reads which legs hit, off the ring round each player.** Green is a hit and
red a miss, as soon as the leg is decided. An under already passed is ringed red in the fourth
quarter of a live game. Before this, every leg of a logged loss came in "Not settled", and unless
each was set by hand the record by side never filled. The screenshot reader also failed on an
entry still in play: it reads "$X for $Y" and "$X paid $Y" but not "$3.75 to win $24.38", so that
entry logged with no stake or payout. It reads all three now.

**The entry's expected value, when no payout table has been confirmed.** An expected value is the
payout table's number as much as the legs' — it is a sum over the table's tiers — and every table
this app ships is marked unverified, because only one of them has ever been read off a real entry
screen. So the Today screen prints the chance every leg hits, which is a product of leg
probabilities and owes the table nothing, and withholds the expected value, pointing at the build
screen, which reads the multiplier off your own screen and refuses to price anything until you
confirm it. The per-leg bar still comes off the stored table, because without one there is no bar
at all — so the bar is labelled `payouts unverified` on its face, and `no payout table` when no
stored table even covers the entry size.

## The path to fitting the priors

Several numbers in this app are reasoned rather than measured, and each is labelled as such where
a reader would act on it: the kickoff widening (4% of variance per day) and college football's
volatility multiplier (1.2), both named in the tracker's line-movement readout; the per-market
dispersion ratios and the yardage spread floors, named on the outcome-spread dial in Settings that
scales them; and the correlation coefficients, named on the correlation dial beside it. Fitting
them needs data the app now collects.

**The tracker reads settled legs along three axes**, not one: by predicted probability band as
before, and now by competition and by market. Each row prints the variance multiplier that would
reconcile what the model said with what happened — the number to move the outcome-spread slider
toward. One axis at a time on purpose: competition by market by probability band is thirty cells
and a hundred settled legs would put five results in each.

That readout **cannot fit the kickoff widening**, and says so. A settled leg's stored probability
already had the widening applied, so comparing it to the result measures what is left after the
correction rather than the correction itself.

**What can fit it is the line history.** Each pull keeps one compact row per prop — the consensus
line, the implied mean and how many books posted it, about 190 bytes, not a copy of the quotes —
and the same prop seen twice at different distances from kick-off gives the spread of the move,
which is exactly the uncertainty the widening prices. The tracker prints the measured variance per
day beside the 4% in use, and counts its pairs out loud rather than quietly fitting six of them.

**It measures hours, not days, and that is a real limit.** Today pulls from local midnight to 11am
tomorrow, so a Sunday afternoon game cannot be pulled on Saturday at all: two looks at one prop can
be hours to about a day apart, never the four days a midweek NFL line actually drifts over. What
the readout shows is the last day's movement scaled to a day, which is a lower bound on the week's.
Closing that gap means a wider pull window, which means more games and more credits per press — a
choice for whoever is paying, not a default worth slipping in.

Legs logged before a competition was recorded sit in their own row. A leg keeps no game and no
start time, so nothing can work out afterwards whether it was a college prop or an NFL one, and
folding them into a guess would report college legs as NFL calibration.

## When the browser runs out of room

Everything lives in this browser, in IndexedDB, as separate records: settings and slips, the line
history, and one slate per league. It used to be one localStorage blob, and localStorage is capped
at about 5MiB — which a PropLine NBA pull, the whole board at every book verbatim, overflows on its
own. The save then shed things to make room and, with nothing else left, shed the pull itself, from
the screen as well as from storage: the pull succeeded, its warnings showed, and the screen said
"Nothing pulled yet". IndexedDB is metered against the device's disk instead, so a full slate fits.
An existing install's blob is moved across on first load, and cleared once it is in.

Separate records also mean only what changed is written. Typing in a settings field used to
re-serialise every cached quote on every keystroke; now it writes the settings record alone.

**Nothing is ever taken off the screen to make a save fit.** If a record still cannot be stored, a
banner in the header names it and says it will be gone after a reload. Where IndexedDB cannot be
opened at all, the app falls back to the old blob and sheds from the *stored copy*, cheapest first
— older line history, then another league's slate, then the rest of the history, then the
imported board — and slips are never shed: they are the only record of what the model predicted.

## Two tabs open at once

Open the app in two tabs, or in a tab and an installed window, and each holds its own copy of
everything in memory. Each used to read storage once, on load, and from then on write the whole
settings-and-slips record from its own copy. So the two never saw each other's changes, and the
one that had been open longer undid the other's whenever it saved anything at all. An Odds API key
pasted into Settings in one tab was gone, or was the previous key again, as soon as a Today screen
left open in another tab switched league — and the next pull failed with "The Odds API rejected
the API key" for a key that was right.

Three things replace that, in order of how much each is relied on:

- **A save carries only what that tab changed.** The record is read and written in one
  transaction, and if another tab has stored it in the meantime, this tab's changes are added to
  what is there instead of replacing it: settings field by field, logged entries one by one, the
  line history pull by pull. A slate is one pull and goes in whole. This is what makes a stale tab
  harmless, and it does not depend on anything arriving.
- **A tab that saves a record says so, and the others read that record again**, so a change shows
  on the other screen without a reload. Only the record's name passes between tabs. The content,
  which includes the feed keys, is only ever read from the database.
- **A tab looks at everything again when it comes back into view.** A tab the browser froze in
  the background heard nothing while it was away.

Where two tabs changed the same field, the one that saved later wins. A change arriving from
another tab is laid under what is on this screen, not over it, so nothing typed is lost to one.
"Nothing is ever taken off the screen to make a save fit" still holds: the only thing that leaves a
screen is a slate another tab removed on purpose, by restoring a file that has none for that league.

What it does not do:

- **Reach another browser or device.** It is still one browser's storage. On an iPhone or iPad an
  app added to the Home Screen has storage of its own, apart from Safari's, so a key saved in one
  is not in the other; Export and Restore under Settings are the way across.
- **Fix a window still running an older build.** One left open across an update writes the old way
  until it is reloaded. What it stores is noticed and added to rather than lost, but it will go on
  undoing other tabs' settings until then.
- **Give the localStorage fallback transactions.** Where IndexedDB cannot be opened the same rules
  apply to the one blob, read just before it is written, which narrows the gap to an instant
  without closing it. A slate shed from the stored copy for want of room stays on the screen of the
  tab that pulled it, at the cost that a slate really removed in another tab stays until a reload.

## Leagues

| | NBA | NFL | CFB |
|---|---|---|---|
| Tab | NBA | NFL | inside NFL, opt-in |
| Feed sport key | `basketball_nba` | `americanfootball_nfl` | `americanfootball_ncaaf` |
| Markets, per-market feed | pts, reb, ast, 3pm, pra | pass yds, rush yds, rec yds, receptions | same as the NFL |
| Markets, per-request feed | the whole board: 11 | same four | same as the NFL |
| Default game cap, per-market feed | 14 | 14 | 6 |
| Default game cap, per-request feed | 15 | 14 | 6 |
| Volatility prior | baseline | its own markets | +20% on the NFL's (unfitted) |
| One default press | 70 credits | 56 credits | +24, and +1 to rank them |

**How wide a press asks is a question about billing, and so is how many games.** The Odds API
charges markets × games, so both are a budget: the NBA's five markets put a full 14-game night at
70 credits, 14% of a 500-request month, which is under the share that makes the button stop and
ask. PropLine charges one request per game whatever the list, so the same budget buys nothing
there — on PropLine the NBA pulls its whole board, eleven markets for the price of four, across
all 15 games for 16 requests of the 1,000 a day. Every market left out is a pick'em line that
could have been read and was not, and since an entry is built only at lines an app is really
posting, a market nobody asked for is a leg you cannot play.

**The game cap splits the same way, for the same reason.** 30 teams means 15 games is the biggest
night the NBA can have, and on PropLine that is 1.6% of a day — so the cap there is the whole
slate. On The Odds API the fifteenth game costs a whole market list: 15 × 5 is 75 credits, exactly
the 15% of a month that makes the button ask, and a default press that asks every single time
teaches you to click through the one gate protecting the quota. So the NBA carries two defaults,
14 and 15, and the feed picks. **This matters because the cap is not a quality filter.** Only a
depth-ranked competition chooses which games to spend it on; everyone else takes them in start
order, so a cap below the slate drops the latest game rather than the worst one — on a 15-game
night, the late West Coast tip, every time.

Changing feed moves the cap with it when the stored cap was only the other feed's default, and
leaves it alone when it is a number you chose. An install from before the split that sits on
PropLine at 14 is moved to 15 on load, for the same reason.

The rest of the NBA board, free on PropLine and addable under Settings → Markets on The Odds API:
pts+reb, pts+ast, reb+ast, steals, blocks, steals+blocks.

**The market list is stored per feed**, because blank does not mean the same thing on both. Blank
on The Odds API is the five-market league default; blank on PropLine is the whole eleven-market
board. One shared box therefore held a number that was a saving on one feed and a pure loss on the
other, and switching feed changed what a press cost without saying so — a four-market list left
blank took a 14-game press from 56 credits to 70, which is under the share that makes the button
ask. Each feed now keeps its own list, the Settings box names which feed it is editing and what the
other holds, and a list typed before this change stays on the feed it was typed for.

**What belongs on that list is decided by the sportsbooks, not by the pick'em apps.** A pick'em
line with no book behind it cannot be priced, cannot become a target, and tells you nothing you
did not already know — so asking for it produces lines that are unusable by construction.
Turnovers is the cautionary case: PrizePicks posts it heavily, no sportsbook in a real pull priced
it at all, and 85 lines came back that nothing could do anything with. It is off the list until
there is evidence a book prices it. Field goals made and free throws made followed on the same
evidence: a real PropLine pull priced every other market on the list and not one book quoted
either. Anyone whose books do post them can type `player_field_goals` or `player_frees_made`
into Settings → Markets. Every pull reports which markets it asked for and got nothing back on,
but only where someone can act on it: on a list typed into Settings, or where each market is
billed per game. A gap in this app's own list on a feed where width is free is this app's to fix,
and telling you to drop a market from a box you left blank was a warning nobody could act on. The combos carry their components, so the correlation model prices PRA against PTS
for one player properly rather than as unrelated stats, and the entry's one-leg-per-player rule
already stops both riding together.

The **prior mean** is used only when no book has priced the prop: a real market price always
wins. A **volatility prior** above baseline widens the distribution, which pulls probabilities
toward a coin flip — the honest response to a less predictable league.

The WNBA and the NHL were both removed, and both still read back. A phone that still has one
selected opens on the NBA, a cache stored under it is dropped on load, and a settled entry in the
tracker still reads off a screenshot and still settles. The NHL needs more care than the WNBA did:
a WNBA screen's "Points" really is the basketball market, while an NHL screen's "Points",
"Assists" and "Blocked Shots" are different stats with different spreads, so the screenshot reader
still recognises an NHL screen and the log form still offers the league. Nothing prices it, which
the form says.

The NFL uses its own markets rather than scaled basketball ones. Yardage is modelled as a
right-skewed count (a 70-yard catch happens, a minus-70 one does not), with a spread near 70
yards on a 250-yard passing line, near 29 on a 65-yard rushing line and near 31 on a 60-yard
receiving line. Passing touchdowns and interceptions are less variable than a Poisson count.
Touchdowns, completions, attempts, carries, interceptions and rush + rec yards are all mapped;
add their feed keys under Settings → Markets to pull them. Anytime and first-touchdown props are
yes/no prices with no line and are not modelled.

The probability at a line a book has actually priced is identical in every league. That is
deliberate and there is a test pinning it: when the market has spoken, a league prior that
moved the number would be inventing an edge.

### NFL notes

Most days have no NFL games. The slate is Sunday, plus Thursday and Monday nights, and the
Today screen names the next game when today has none. Props are posted days ahead and move
hard on injury and weather news, so pull on game day. A full Sunday at the default four
markets is about 56 credits, plus 24 for the college games pulled with it, and the Today screen
shows that total before you press the button.

Two things make the numbers here more honest than a dispersion ratio alone:

**The button asks before an expensive press.** Above 15% of a 500-request month — 75 credits, six
presses from an empty month — the pull is a confirm rather than a note beside the button, because a
note is read after the credits are gone. The figure is summed per competition, since each can be
asked for a different market list and credits are billed per market per game. A full Sunday with
college football switched on is 80 credits, so that press asks; the NFL alone, at 56, does not.
Neither does a full NBA night at its per-market cap, at 70 — which is why that cap is 14 and not
the 15 PropLine pulls: the fifteenth game would put the default press at exactly 75 and make the
gate fire on every single press, which is how a gate stops being read.

**Yardage carries a floor on its relative spread.** A ratio prior implies that the spread
grows with the square root of the projection, so a 340-yard passing line came out with a
standard deviation of 80 yards — 24% of the mean, where a real passing line sits near 28%.
Every probability built on that was too confident, and an overconfident probability is a
phantom edge. Passing, rushing, receiving and rush+rec yards now get the wider of the ratio
prior and a floor of 27%, 45%, 52% and 45% of the projection. Below the crossover the ratio
still governs, because a low-volume receiver really is more erratic than a proportional
spread allows.

**A line priced days before kickoff is widened for the days in between.** Four percent of
variance a day, capped at twelve percent. The price was right for what was known on Tuesday;
what Sunday's injury report will say is real uncertainty and belongs in the distribution
rather than in a footnote. On a slate pulled the same evening it changes nothing.

The feed does not say which team a player is on. A quarterback and his own receiver are
therefore linked only as players in the same game, not as a stack, so the correlation between
them is understated for same-team legs and overstated for opponents.

### College football notes

CFB is a companion of the NFL tab, not a tab of its own: same sport, same markets, same
weekend, and the pick'em apps put both on one board. It is pulled in the same press, capped at
six games because a Saturday lists fifty and only the televised ones carry real prop pricing,
and priced with its own numbers rather than the NFL's:

- **20% wider at the same projected mean.** The talent gap between the two rosters is often
  enormous, starters sit out the fourth quarter of a blowout, and the backfield split is far
  less knowable than in the NFL. All three widen the outcome, and a wider outcome means a
  probability closer to a coin flip.
- **Its own plausibility ceilings**, because a 500-yard passing game and a 300-yard rushing
  game both happen in college football and NFL ceilings would flag real outcomes as impossible.

**Which six games get the cap is chosen, not taken in start order.** A Saturday lists fifty and
the earliest kick-off is as likely to be a game no book prices as the one everyone does, so one
sport-level call for spreads — billed per market per region, so a single credit whatever it
returns — says who the books are actually pricing. Games are ranked by how many books hang a
spread, ties to the closer game, and anything over 21 points is skipped because a four-touchdown
favourite benches the players a yardage prop is on. That is also why the section asks for all four
football markets rather than a trimmed pair: the games it selects are the televised ones, which are
exactly the games where receptions and receiving yards exist. If the ranking call fails the slate
falls back to start order and says so, and what it did is reported on screen so a thin board reads
as expected rather than broken.

Most of a Saturday slate comes back unpriced and is correctly left out: no sportsbook price,
no expected value, no exceptions.

### Why the NHL was dropped, and what the board kept from it

The NHL was here because it is where a pick'em app's even-money payout is most often wrong:
small counts on half-point lines, where the books price one side well past a coin flip and the
app pays it as if it were even. That is a real effect and it was not enough. The pick'em apps
post a thin slice of the hockey board, the starting goalie is confirmed too late to price saves
with any confidence, and every credit and every hour spent on it was one not spent on the NBA,
which posts more props, prices them deeper, and runs most nights of the week.

Two failures were found there first, and both were general. Both are now pinned on the NBA,
because they bite on any low-count market — blocks, steals and threes hit the same arithmetic as
shots and points:

1. **Markets no pick'em app posts.** A prop priced at 0.5 against a mean near 0.25 makes the
   favoured side an 80% under. Sorted by hit rate, those came out on top of the board. No pick'em
   app offers a prop that lopsided — the payout table only works if both sides are plausible — so
   a target whose every posted line is more lopsided than 80/20 is dropped from the pick'em
   section, counted, and named on screen rather than silently missing. The value-bet side of the
   app still prices it: a lopsided price is still a price, and still worth betting if it is wrong.
   A line PropLine shows an app really posting is never removed this way, because the ceiling is a
   prior about what a board offers and a real line beats a prior.
2. **Lines no board has ever shown.** The thresholds and the probability ladder used to sweep a
   fixed window around the projection, which gave a 0.4-mean market lines up to 16.5 and a
   27-point scorer lines down at 11.5. The search now covers the lines the books are actually
   hanging, widened half a standard deviation for an app that hangs a slightly different number.
   The same fix cuts a 250-yard passing ladder from two hundred rows to fifty.

Hockey markets stay in the taxonomy — shots on goal, goalie saves, hockey points, assists, goals,
blocked shots, power-play points — and are read as hockey whenever an entry is an NHL one. That is
the whole of what remains: enough to read and settle what is already logged, and nothing that
spends a credit.

College basketball and the WNBA were removed. A phone that still has one selected opens on
the NBA.
