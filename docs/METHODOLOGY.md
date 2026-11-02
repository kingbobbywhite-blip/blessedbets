# Methodology

Every number the app shows traces back through the same steps. This document explains each
one and names the assumptions, because an expected-value figure whose assumptions you cannot
see is worse than no figure at all.

## 0. The pricing gate

A prop is **priced** only if a real sportsbook price stands behind it. Everything else is
**unpriced**: shown on the board for context, excluded from expected value, and rejected by
the optimizer.

This is the most important rule in the app and it is not configurable. Without it, a
projection assembled from season averages gets compared against a line the market has
already priced, and the difference between the two gets reported as edge. It is not edge. It
is the gap between a weak estimate and a strong one, pointing the wrong way.

## 1. Strip the vig

A sportsbook's posted price is not a probability. It is a probability plus a margin. A
standard `-110 / -110` prop implies 52.4% on each side, summing to 104.8%. That extra 4.8%
is the hold.

Comparing a DFS line to a raw implied probability manufactures edge that does not exist.
Four devigging methods are available:

| Method | Behaviour |
| --- | --- |
| **Power** (default) | Solves for `k` where the sum of `p^k` equals 1. Handles the favourite-longshot bias reasonably and is the best general choice for player props. |
| **Shin** | Models the margin as protection against informed bettors. Shades longshots harder. |
| **Proportional** | Divides each price by the overround. Simple, but overstates longshot probability. |
| **Additive** | Subtracts the margin evenly. Only defensible on near-even two-way markets. |

If only one side is priced the hold cannot be measured, so a typical margin is assumed and
the resulting projection is marked lower confidence.

Power is the default. Proportional devigging spreads the margin evenly in probability terms,
which overstates longshot probability, and on a prop board the longshots are exactly the
sides sitting furthest from the number. Selecting it in settings raises a warning.

### Not every book counts equally

A handful of books make the market: they take large limits from sharp bettors, move on that
action, and their number is the closest thing to fair that exists. Most retail books copy
those numbers with a wider margin and shade them toward public money.

| Book | Tier | Weight |
| --- | --- | --- |
| Pinnacle | market-making | 1.00 |
| Circa | market-making | 0.85 |
| BetOnline, BookMaker | sharp | 0.50 |
| LowVig | sharp | counts as BetOnline |
| DraftKings, FanDuel | retail | 0.20 |
| BetMGM, Caesars | retail | 0.15 |
| ESPN BET | retail | 0.10 |
| Anything unrecognised | unknown | 0.10 |

**Books that share a feed count once.** LowVig is BetOnline's reduced-margin sister site,
hanging the same lines at less juice, and Caesars arrives under two ids. Counted separately,
BetOnline carried 0.95 of weight on every prop both posted — about two thirds of an NBA
consensus on PropLine, which carries no Pinnacle player props — and the depth of that one
opinion pushed the consensus quality to its maximum. A shared source now contributes once, at
its heaviest book's weight, and in leave-one-out a sister book is left out along with the book
being judged, so a LowVig price is never measured against BetOnline's.

**Without a market maker, the retail books have to agree.** Where Pinnacle or Circa priced a
prop, its number is the reference and a retail book lagging it is the classic edge. Where
neither did, the consensus is one sharp book's opinion blended with the retail market's, and
the sharp book has the larger say: on PropLine, BetOnline two points under FanDuel, DraftKings,
Bovada, BetMGM and the pick'em app's own line turned a coin flip at that line into a 58% pick.
So with no market maker, each side's chance is the lesser of the consensus's and the retail
books' own, and the row says when the two disagree. An edge the whole market sees survives it;
an edge one offshore number sees on its own does not. The same rule judges retail offers as
value bets.

The combined retail weight is capped at 0.45 no matter how many retail books are present.
That cap matters: retail books copy the same source, so five of them is one opinion counted
five times, not five independent opinions. Without the cap a crowd of copycats outvotes the
book that set the number.

Each book's price is converted to an implied mean at its own line, and the consensus is the
weighted average of those means. Going through the mean rather than the probability is what
lets books posting different numbers be combined at all. A row with no market-making book
behind it is flagged, and settings can be set to treat it as unpriced outright.

Quotes carry a timestamp. Past the stale threshold they are flagged; past the discard
threshold they are thrown out and the prop reverts to unpriced. Lines move on injury news, so
a price from before the inactives were posted is worse than no price.

## 2. Turn the fair probability into a projection

Given that the fair probability of clearing 25.5 points is 53%, what average must the player
be expected to score? The app inverts the line probability through the market's own outcome
distribution to recover an implied mean.

This matters because the DFS app is usually offering a *different* number than the
sportsbook. Recovering the mean lets the same market opinion be re-evaluated at 24.5, or
26.5, or wherever the app has it.

### When there genuinely is no price

Unpriced props still get an estimate where one is possible, so the board is not full of blank
rows, but the estimate never promotes them to priced.

The order of preference:

1. **Game log.** Per-game values give both a centre and a *measured* spread. A season average
   gives a centre and nothing else, so a player averaging 20 on steady 14-shot nights and one
   averaging 20 on wild 8-to-34 swings look identical, when they are completely different
   bets at the same line. Where minutes are present the projection is rebuilt as
   per-minute rate times projected minutes, which is what makes a rotation change tractable.
   Recent games are weighted more heavily; the observed spread is floored at the market prior
   so a short flat log cannot claim certainty, and widened further below ten games.
2. **A supplied projection**, priced with the market's prior spread.
3. **Season and recent averages**, the weakest input the app accepts, flagged as such.
4. **Nothing.** The row is kept so you can see what you captured, but shows dashes rather
   than a manufactured coin flip.

Minutes are adjusted before anything else, because minutes drive every counting stat:
a back-to-back trims 1.5, three or more days rest adds 0.5, and each rotation player ruled
out adds two, capped at six. The adjustments are deliberately small. A wrong minutes call
ruins the projection, and a large speculative adjustment is worse than none.

## 3. Model the outcome distribution

Box-score stats are integers, and small-mean counting stats are strongly skewed. Treating
them as normal misprices exactly the tails where parlay legs live, and prices whole-number
pushes at zero.

The app picks a discrete family from the mean and variance:

- **Negative binomial** when overdispersed, which covers points, rebounds, assists.
- **Poisson** at parity, which covers steals.
- **Binomial** when underdispersed.
- **Normal** for genuinely continuous stats such as minutes.

Dispersion is a per-market ratio of variance to mean:

| Market | Ratio | At a 25 mean this implies |
| --- | --- | --- |
| Points | 2.60 | standard deviation ≈ 8.1 |
| Pts+Reb+Ast | 2.20 | ≈ 7.4 |
| Rebounds, Assists | 1.25 | ≈ 5.6 |
| 3-Pointers Made | 1.15 | ≈ 5.4 |
| Steals | 1.05 | ≈ 5.1 |

These are priors fitted to typical NBA game-log behaviour, not measured constants. NFL markets
have their own ratios (passing yards 19, rushing yards 13, receiving yards 16, receptions 1.1,
passing touchdowns 0.8) and are not scaled. College football scales the football ratios by 1.2,
because a blowout, a benched starter and an unknowable backfield split all widen the outcome.
Note that holding the ratio fixed while the mean falls already widens the relative spread, since
variance/mean = r implies sd/mean = sqrt(r/mean); the multipliers sit on top of that. They are
the single largest modelling assumption in the app, and the outcome-spread slider in
settings scales all of them at once.

**Yardage markets also carry a floor on the relative spread**, because that same identity cuts
the wrong way at the top of the range: sd/mean = sqrt(r/mean) means the ratio prior makes a big
projection look more predictable than it is. At ratio 19 a 235-yard passing line gets a standard
deviation of 67 (28% of the mean, about right) and a 340-yard line gets 80 (24%, far too
confident). Passing, rushing, receiving and rush+rec yards therefore take the wider of the ratio
prior and a coefficient of variation of 0.27, 0.45, 0.52 and 0.45. The outcome-spread slider
scales the floor too, so widening uncertainty still widens the answer.

**A line priced before kickoff is widened for the wait.** Four percent of variance per day until
the game starts, capped at twelve percent. Football props post days ahead and move on injury,
depth-chart and weather news; the price was correct for what was known when it was posted, and
the rest is uncertainty that belongs in the distribution. Under four percent on a slate pulled
the same evening, so it is a football correction in practice.

UNFITTED, and the app says so wherever it shows. What would fit it is the same prop's line seen
twice at different distances from kick-off: the spread of that movement IS the uncertainty the
factor prices, because what the factor says is "we do not yet know what the line will be at
kick-off". Each pull therefore keeps a compact row per prop and the tracker prints the measured
variance per day beside the 4% in use, scaled against the outcome's own variance so a 12-yard move
on a 250-yard line and a half-shot move on a 3-shot line are comparable numbers. The spread is
measured about the mean move rather than about zero, so a market that drifts one way all week is
treated as a bias to correct rather than noise to widen for. Pairs are joined on the prop AND the
fixture's start time, because a game id is two team names and the same two teams meet again.

The gap it can observe is hours rather than days: the Today screen's window runs from local
midnight to 11am the next morning, so a Sunday game is not pullable on Saturday. The measurement is
therefore the final day's movement extrapolated per day, which is a lower bound on a week's drift,
and the tracker says so beside the number.

**The gap between what was predicted and what happened implies a spread.** The dial multiplies
variance, so a multiplier k scales each leg's distance from the line by 1/sqrt(k); the k that would
have turned these predictions into this hit rate is the one solving mean_i Phi(z_i / sqrt(k)) =
actual, found by bisection over the dial's own range. Solved over the individual legs rather than
their average, because Phi^-1 of a mean is not the mean of Phi^-1 — a group holding a 55% leg and
an 85% leg does not behave like two 70% legs. The tracker prints it per competition and per market.

Four limits, all stated beside it: it is a normal approximation to count distributions; a group
whose predictions or whose realised rate sit on a coin flip carries no information about width and
reports nothing rather than a number nobody can act on; beyond the dial's range it reports the
limit, because a multiplier of 17 is not advice when the slider stops at 1.8; and because the
stored probability already carried every correction the app applies, it measures what is LEFT
rather than any one correction, so it cannot be used to fit the widening above.

Uncertainty about the projection is folded into the outcome spread. A shaky projection
produces probabilities closer to 50%, which is the honest response to not knowing.

### Line resolution

- Half-point line (24.5): over is `P(X ≥ 25)`, under is `P(X ≤ 24)`, no push.
- Whole-number line (24): over is `P(X ≥ 25)`, under is `P(X ≤ 23)`, push is `P(X = 24)`.

Pushes are not losses. On a DFS entry a pushed leg voids and the entry shrinks to the next
smaller payout table, which the simulator reproduces.

## 4. Model correlation between legs

Multiplying leg probabilities assumes independence. NBA legs are not independent:

- A player's points and threes move together (≈ +0.46).
- A player's points and his PRA are nearly the same bet (≈ +0.7).
- Team-mates compete for shots, but share pace and overtime. The net is near zero.
- A guard's assists and his team-mate's points are linked by the made basket.
- Opposing players share the game's pace.
- Betting opposite sides of correlated stats flips the sign.

Legs are simulated under a Gaussian copula: draw correlated normals, compare each against
thresholds derived from that leg's win and push probability. The correlation matrix is
assembled from structural priors, then shrunk toward the identity until it is a valid
covariance matrix. Shrinking toward the identity means shrinking toward independence, which
is the conservative direction.

Every entry reports what its expected value would have been under the independence
assumption, so the size of the correction is always visible.

## 5. Price the entry and size the stake

### The payout comes off your screen

Stored payout tables are seeds for a form, not a source of truth. Operators change
multipliers by state, by promotion and by sport, and boosted picks override them outright. So
the build screen shows a capture panel pre-filled from the stored table, you correct it to
whatever the app is displaying, and you confirm it. Nothing is priced until you do, and the
captured table is stored with the slip so settlement later uses the same numbers.

### Break-even, printed beside every expected value

The per-leg hit rate at which an entry returns exactly the stake is the sum across every
paying tier:

```
E[M] = sum over k of  C(n,k) p^k (1-p)^(n-k) * M(n,k)
```

solved for the p where `E[M] = 1`. For an all-or-nothing table this reduces to the familiar
`M^(-1/n)`, but for anything with partial-payout tiers that shortcut ignores every dollar the
lower tiers return and is badly wrong. A PrizePicks 3-pick flex breaks even at 59.1%; the
shortcut claims 76.3%.

That number sits next to every expected value in the app, with the legs' average probability
under it. It is a sanity check you cannot avoid looking at: if the break-even is not a
plausible per-leg hit rate, the captured multiplier is wrong and the expected value beside it
is fiction. An entry whose break-even lands outside 35% to 85%, or whose expected value
exceeds twenty percent, says so on the card.

The simulation produces a full distribution over payout multiples, not just a win
probability. Expected value is the probability-weighted return, less the stake.

Stake sizing uses Kelly generalised to multi-outcome payoffs: it maximises expected log
growth numerically rather than using the two-outcome closed form, because a flex entry has
three or more possible returns.

Two guards sit on top:

- **Fractional Kelly**, defaulting to a quarter. Full Kelly is growth-optimal only if your
  probabilities are exactly right. They are estimates, and overestimating edge makes Kelly
  overbet in a way that compounds badly.
- **A hard percentage cap** per entry, defaulting to 2% of bankroll, which overrides Kelly.

## The optimizer

Rather than a fixed rule such as "one leg per stat market", the app runs a beam search over
candidate legs, scoring each partial entry with the correlation-aware simulator against the
real payout table for the selected app and mode. Constraints on legs per game, legs per
team, legs per player and average correlation are applied during the search.

Objectives available:

- **Max expected value** — highest average return per dollar.
- **Max bankroll growth** — maximises expected log growth at the Kelly stake, which is what
  actually compounds. Prefers lower variance.
- **Highest floor** — maximises probability of profit among entries that are not negative EV.
- **Upside** — chases the largest payout without going negative EV.

Results are deduplicated and diversity-filtered so you get genuinely different entries
rather than five variations on the same four legs. The simulation is seeded from the entry's
own contents, so the same slate always produces the same recommendations.

## Calibration

The tracker compares the probability the model gave each leg against whether it actually
cashed, bucketed by predicted band, and reports Brier score, log loss and overall bias.

A model that says 70% and delivers 55% will drain a bankroll while looking like variance.
Calibration is the only diagnostic that catches it. It needs volume: a gap is only
highlighted once it exceeds two standard errors on at least twenty legs, and the headline
bias figure stays neutral until roughly a hundred legs have settled.

### Profit comes from what the app paid

An entry logged from its settled screen carries the amount the app returned: "$10 paid $5",
or nothing under a Loss badge. That amount is the result. It already includes goblins, demons,
reboots and whatever table the app really used, so the entry is settled at it even before its
legs are filled in, and changing a leg afterwards only changes the record by stat. An entry
still in play has no payment to read and settles from its legs against the captured table.

### Goblins and demons

PrizePicks marks a boosted pick with a small face beside the line, green for a goblin and red
for a demon. Text recognition reads both as the same junk letters, so the face is found by
colour instead: saturated green or red in the line box's band of the row, with pixel rows a
progress bar crosses skipped. Each logged leg records its pick type, and the tracker keeps
goblins, demons and standard picks in separate records, because each is priced to hit at a
different rate.

### Which legs hit, off the ring

Each player on an entry screen sits in a ring that turns green when the leg hits and red when
it misses, with a tick or a cross added once the game is over. The number at the end of the
progress bar sits in a coloured bubble that text recognition reads as junk, so the result is
read the way the goblin is: by colour, in the band of the row where the ring sits (11-26% of the
width), skipping pixel rows a progress bar crosses, since a hit's bar is the same lime and
starts in the same band. The leg's name row and stat row are each read on their own, and the two
reads of the screenshot are combined. Rows or reads that disagree claim nothing, so the leg is left
for you to set.

The colour is set when the leg is decided, not when the game ends. A real screen ringed an under
red in the fourth quarter of a live game, because it had already been passed and could not come
back, and that is the right reading. A leg still open is ringed in neither colour and stays
unsettled. A Reboot outranks the ring, and so does a result typed beside the leg.

An entry still in play heads its screen "$3.75 to win $24.38" rather than "$X for $Y". It is
the same number, the whole return if every leg hits. Read as profit, that 4-pick would be
7.5x. Read as the return it is 6.5x, which matches the four-goblin 4-pick from the same night
at "$10 for $40" (4x): each goblin cuts the 10x table by about a fifth.

### Overs and unders

The tracker splits every decided leg, priced or not, by league and side: NBA overs, NBA unders,
NFL overs and so on. Each row prints its hit rate beside the per-leg rate its own entries needed
to break even, averaged over the legs whose entry had a payout to work it from. That second
number is what makes the first readable. Sixty percent wins on a standard 2-pick and loses on a
four-goblin 4-pick at 4x, which needs 70.7%.

Where a league has both sides, the two rates are compared with a pooled two-proportion test. A
gap counts only when it is over two standard errors and each side has at least twenty legs.
Below that the screen says how wide a gap luck alone makes on those samples. The same split runs
through calibration as a "By side" table, for the legs the app priced.

### Overlap across entries

The same leg in two entries is the same bet twice, and an over in one entry with an under at
the same line or higher in another cannot both hit. Open entries are checked as they go in.
Settled entries are grouped by the day they were logged and checked afterwards, because
entries logged from screenshots arrive already settled.


## The daily pipeline

The one-button flow runs the same engine over data it fetches for itself.

### Finding a mispriced offer

A handful of books set the number and the rest copy it, with a lag. When a retail book is
still offering Over 24.5 at -105 while the sharp consensus says that side is worth -130,
the difference is yours.

Two rules keep this from being circular:

1. **Leave-one-out.** The book being evaluated is excluded from the consensus it is
   measured against. Otherwise a book partly prices itself and every quote looks slightly
   like value.
2. **A real reference.** At least one market-making book must remain after that exclusion.
   A consensus of copies is not a reference price, it is the same lag measured twice.

For each surviving offer the consensus mean is inverted into a distribution, the fair
probability at *that book's line* is read off it, and the edge is `fairProb × decimal − 1`.
Anything above a configurable floor is reported, with a full-Kelly fraction attached.

An edge above 12% is flagged and sorted below smaller believable ones. On a liquid market
a double-digit edge is a line that already moved, a prop matched to the wrong player, or a
book about to void the bet, far more often than it is free money.

### Building the parlay

Parlays are constructed only from legs that are individually positive expected value.
There is no combination of bad bets that becomes a good one; stacking small losses
multiplies the loss.

They are also built **one book at a time**. A leg at DraftKings cannot be combined with a
leg at FanDuel onto a single ticket, so taking the best price for each leg across books
produces a parlay nobody can place. Within a book every leg is priced at that book's own
number, and the best parlay across all books wins.

Payout is the exact product of the surviving legs' decimal prices, not an approximation, so
a pushed leg drops out of the parlay rather than losing it. The break-even figure shown
beside a parlay's expected value is the per-leg rate an equivalent all-or-nothing entry
would need, which makes it directly comparable to the pick'em bar.

Every parlay leg has to be at least a coin flip. The floor used to be 30%, on the reasoning
that a sportsbook's price carries the value: a +160 leg that hits 45% of the time is a good bet
on its own. Three of them hit about one time in eleven, and the parlays that built were ones you
could see would not hit. A long-odds leg is also where the edge is least believable — its fair
chance comes from the tail of the consensus, where the devig method and the dispersion prior
matter most — and a parlay multiplies that error once per leg. Long-odds edges are still listed,
as single bets.

### Pick'em targets

Nothing in this codebase can see a DFS app's board. Rather than guess, the app walks
half-point lines outward from the projection and reports the last one on each side that
still clears the per-leg hit rate your entry size requires.

That turns "tell me what to play on PrizePicks" into something answerable: here is the
player, here is the number, take the over only at or below it. If neither side clears, the
prop is a pass, which is the correct answer more often than people expect.

**An under can be asked for more.** Settings carries a margin per league that an under has to
clear on top of the bar. It starts at three points in the NBA and at nothing elsewhere, so with
the NBA margin a 56% bar asks 59% of an under and still 56% of an over. The NBA's three points
are the user's own prior, that NBA unders have not hit as priced. They are not a measured number.
The margin is safe to carry for one reason: its direction. It moves no probability, so every
chance on screen is still the market's. It only moves the under threshold outward, turns some
under plays into passes and keeps them out of the entry, and a row it holds back says so instead
of "neither side clears". The overs-and-unders record is where it gets tested.

### The apps' own lines

With a PropLine key, the lines PrizePicks and Underdog are posting arrive with the pull.
They are split from the sportsbook rows before anything is priced, because they are lines,
not prices: PropLine serves PrizePicks at a synthetic +100/+100 on every pick, and an
even-money row in the consensus would drag every fair price toward a coin flip.

Each app line is matched to a target on player and market (not game: two feeds rarely
spell a team the same way, and a player has one game a day) and priced off the target's
own distribution, the one the sportsbook consensus built. A whole-number line gets its
push probability, which voids the pick.

The pick'em entry then plays the default app's real line: for each prop it takes the side
with the better chance at that line, among the sides offered as a standard 1.0 pick, and
re-checks the bar there. A line two points harder than the books' can drop a prop below
the bar, and a prop the app is not offering is left out because it cannot be played. When
the pull carried nothing from that app, every leg is at the books' line instead — never a
mixture of the two in one entry.

"Not offering" is decided per game **and market**. If the app posted lines in that market,
in that game, for anyone, and not for this prop, the prop is not on offer there. If no line
from the app reached that game and market at all (a request failed, PropLine did not list
the game, or the app simply does not post that stat there), the prop is unknown rather than
absent. Either way it is out of that app's entry, because an entry is never built at a line
the app may not be posting, and the two counts are reported separately under the card so the
inference is visible rather than silent.

Per market, not per game, because an app covering a game says nothing about which stats it
covers in it: PrizePicks will post points for every starter in a game and no rebounds line
in it anywhere. Keyed on the game alone, every one of those rebounds props read as "offered,
and this player is not on it", which is a different claim from the truth. With The Odds API pricing the slate, the
pick'em pull asks PropLine for exactly the games that were priced, matched on the teams'
nicknames and start time, so the two feeds cover the same slate.

A pick'em line is dropped once its game has started, when PropLine marks the app frozen on
a live game, or when the app has pulled the market. An app stops taking picks at the start,
and the pregame line it leaves behind, judged against live sportsbook prices, would read as
a near-certain hit. For the same reason the entry never takes a leg from a game that has
started, even at the books' line: the books may still be pricing it in play, but no pick'em
app will take it. The note under the targets says when started games are why lines are
missing.

The target row fills in the default app's line and answers by the entry's rule: it names a
side only when the app offers it as a standard pick and it clears the bar. When the likelier
side is one Underdog has discounted (a 0.85x Higher, say) or one the app does not offer, the
row reads as a pass and says which, because a discounted side needs a far higher hit rate
than the standard bar, and the app does not compute that bar.
