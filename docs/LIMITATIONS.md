# What this cannot do

Read this before betting real money.

## The honest summary

This app does not create an edge. It stops you acting on ones that are not there.

Everything it does well is subtractive: refusing to price props with no market behind them,
forcing you to read the payout off your own screen, printing the break-even next to every
expected value, marking retail-only prices as weaker than sharp ones. None of that finds you
money. It stops you giving money away to your own bad inputs.

**A +15% expected value reading is almost always a bad input.** In that order of likelihood:
a mistyped payout multiplier, a stale sportsbook price, a prop matched to the wrong player, a
line that already moved on injury news, a game log that includes minutes the player will not
see tonight. Genuine edge on these products lives in the low single digits, and it is rare.
When the app shows you a large number, the correct first response is suspicion, and the app
now says so on the card.

**The real edges are stale lines, and using them gets you limited.** The reliable ways to beat
a pick'em app are taking a number the operator has not moved yet, and taking the better of two
numbers across two apps. Both work. Both are also exactly what operator risk teams look for,
and consistently doing either gets your account restricted, your limits cut, or your entry
sizes capped. That is not a flaw in the strategy. It is the business model, and any plan that
assumes indefinite access at current limits is wrong.

## 1. Payout tables still have to be checked by a human

The capture step fixes the mechanism but not the diligence. If you confirm a payout you did
not actually read off the screen, everything downstream is wrong and confidently so. The
break-even figure beside each expected value is the safety net, so look at it.

Boosted picks (PrizePicks demons and goblins, Underdog boosts) change both the multiplier and
the implied probability of the pick itself. The app models the multiplier if you type it in.
An entry logged from a screenshot has its goblins and demons read off the screen by colour
and recorded per leg, so the tracker can keep their records apart. The pick'em targets on
the Today screen still assume a standard pick: a goblin or demon needs its own bar.

They also move every flex tier, not just the top one, and the entry screen only ever shows the
top. A settled flex entry is therefore scored at what the app says it paid ("$10 paid $5"),
never at a stored table: that 5-of-6 goblin flex would otherwise have gone into the tracker as
a $10 profit instead of a $5 loss. When the table and the payment disagree, the entry says so.
An entry that is still open has no payment to read, so it settles from its legs and the table.

## 2. Injuries, rest and rotations are still not modelled

There is no news feed. A star ruled out ninety minutes before tip changes every team-mate's
projection, and the app will not know. The minutes context on the no-odds path is a manual
lever that requires you to already know.

A sportsbook price *does* reflect news, which is another reason the priced path is worth so
much more than the game-log path. But a price captured before the news is stale, and stale is
worse than absent. Set the discard threshold low and re-pull close to tip.

## 3. OCR is wrong often enough to matter

Reading a dense mobile screenshot is not reliable. Decimal points vanish, `0` becomes `O`,
long names truncate. Every OCR row is unconfirmed until you tick it, and the app will not load
a slate with unreviewed rows. That gate only works if you actually look. Capturing fifteen
props you would genuinely consider, rather than the whole board, is what makes reviewing them
properly realistic.

Player names are matched to feed quotes exactly, never fuzzily. Attaching Jalen Williams'
price to Jaylin Williams would be far worse than leaving the prop unpriced, so unmatched names
are reported rather than guessed.

## 4. The daily picks are sportsbook bets, not pick'em picks

The automatic flow finds mispriced offers **on sportsbooks**, because that is the only
place prices can be read from. Without a PropLine key it cannot see PrizePicks at all.

The pick'em targets are the bridge: a number to check against your own screen. With a
PropLine key, the lines PrizePicks and Underdog are posting are read through PropLine's
licensed feed (nothing is scraped) and the entry is built at those lines. That narrows the
gap but does not close it:

- The lines are as fresh as the last pull. A line that moved after it is not the line on
  your screen; the app fills in what it read, says how old the reading is once it passes the
  same staleness threshold the sportsbook prices use, and lets you overwrite it.
- Only standard picks go into the entry. Goblins, demons and Underdog's boosted or
  discounted sides are listed with their chances but need their own bar. On PrizePicks a
  flavoured pick changes the multiplier for the WHOLE entry rather than for its own leg, so
  the right bar for an entry holding one is the break-even of that entry's real multiplier —
  which the app cannot know until you read it off your screen. Until you do, the board says
  how many flavoured lines are on it and calls the stored bar a floor. Once you do, every leg
  in that entry is judged against the real bar, because the flavoured pick's cost is already
  inside the multiplier you read.
- What PrizePicks posts says nothing about what a pick is worth. PropLine serves PrizePicks
  at a synthetic even-money price, and every such row is kept out of the pricing.
- Coverage is PropLine's. A player the feed has not mapped, or an app it does not carry
  (Sleeper, Real, Winible), has no line to build at, so the prop is left out of that app's
  entry and counted under it rather than entering at the books' number. An entry is built at
  one app's real lines or at the books' lines, never at a mixture: a card headed with an app's
  name and a payout table, holding legs at numbers the app may not be posting, prints an
  expectation that is fiction, and nothing on it says which legs those are.
- Whether an app is "not offering" a prop or merely was not seen offering it is an inference,
  not a fact the feed states. It is drawn per game and market — if PropLine carried any
  PrizePicks line for that market in that game, the market is taken as covered there — and it
  can still be wrong when PropLine's own coverage of a market is partial. The two cases are
  counted separately on screen so the inference is visible rather than silent.

## 5. The odds feed costs money and burns quota fast

Player props on The Odds API are billed per market per event. Fourteen markets across a
twelve-game slate is 168 credits for one refresh. Narrow the market list to what is on your
board, narrow the book list to the ones that carry weight, and expect to re-pull before tip
rather than continuously.

PropLine bills per request instead: one for the game list and one per game, whatever the
markets, against 1,000 a day free. Because width is free there, the NBA asks PropLine for its
whole board — eleven markets for the price of four — and asks The Odds API for five.

The trade is the reference price. PropLine's Pinnacle feed carries no basketball or football
player props, so with PropLine pricing the slate the sharp reference is BetOnline (LowVig is the
same book under another name and counts once), and a prop it does not post is left unpriced while
"require a sharp book" is on. With no market maker in the room, a side is priced at the lesser of
the consensus and the retail books' own number, so an edge only BetOnline sees is not one. Pinnacle via
The Odds API, with PropLine supplying only the pick'em lines, keeps the stronger reference and
the narrower market list at the same time, which is a real trade rather than a free choice.

If the feed fails, props stay unpriced and the optimizer refuses to build. That is the
intended behaviour, not a bug.

## 6. Dispersion ratios are priors, not measurements

The variance-to-mean ratios per market are reasonable NBA-wide values, not player-specific
ones. A steady role player and a streaky shooter with the same average get the same spread
unless you supply a game log. The tracker's calibration table is what catches this.

## 7. Correlations are structural priors, not fitted

The correlation values come from how basketball works, not from a fitted covariance matrix on
real game logs. They are directionally right and conservatively sized, but a specific pairing
could be materially off. When the assembled matrix is not a valid covariance matrix it is
shrunk toward independence, and any entry that needed heavy shrinkage says so.

## 8. Beam search does not guarantee the optimum

The optimizer explores a wide but not exhaustive set of combinations. "Max expected value"
means "best found", not "provably best".

## 9. Monte Carlo numbers wobble

Entries are simulated 25,000 times. Two expected-value figures within about half a percentage
point are not meaningfully different. Do not choose between entries on a 0.3-point gap.

## 10. Results take a long time to mean anything

At a 5% edge with typical parlay variance, hundreds of entries are needed before profit and
luck can be told apart. A losing month proves nothing. A winning month proves nothing either.
Calibration converges faster than profit, which is why the tracker leads with it, and the
headline calibration figure stays neutral until roughly a hundred legs have settled.

## 11. Everything lives in one browser

No server, no account. Clearing site data deletes your history. Export from settings
regularly.

## 12. Exchange and prediction-market support is partial

ProphetX and Polymarket are modelled in the payout registry, and their prices can be imported
and shown on the board, but the build screen optimises DFS pick'em entries only. A PropLine
pull carries their prop prices too, and either can be ticked as a place to bet under
Settings. Exchange offers with less than $25 behind them are dropped as not bettable, and
exchanges never count as a sharp reference. The commission recorded for each app under
Settings → Payouts (ProphetX's 2% on net winnings) is taken off before an exchange bet's
edge and stake are judged, and off a parlay built at that exchange.

## 13. The odds feed does not say which team a player is on

Correlation between legs in a daily parlay is detected at game level, not team level. Two
team-mates in the same game are correctly treated as correlated through pace, but the
usage competition between them, and the assist-to-scorer link, are invisible. Slates
captured with team columns do get the full model.

## 14. Legality varies

Sports betting and daily fantasy are regulated differently in every jurisdiction and are not
legal everywhere. Nothing here is financial advice.

## League coverage

Two sections are supported: NBA and NFL (with college football inside it). What is NOT modelled
per league:

**College basketball, the WNBA and the NHL were removed.** Re-adding any of them is mostly a data
entry in `lib/leagues`, but their tests and notes went with them. A stored pull or a phone still
set to one opens on the NBA, and a cache filed under one is dropped on load.

Their settled entries still read back, which is the part that is not optional: settled history is
the only thing in this app that can tell you the model is wrong. WNBA team codes stay in the
screenshot reader. The NHL needs more than that, and gets it: a WNBA screen's "Points" really is
the basketball market, while an NHL screen's "Points", "Assists" and "Blocked Shots" are
different stats with different spreads. So the hockey market taxonomy stays, the screenshot reader
still recognises an NHL screen, and the log form still offers the league — enough to read and
settle what is already logged, and nothing that spends a credit. Nothing prices a hockey leg:
there is no NHL slate to compare it against, which the log form says rather than showing an empty
number.

**College football is thin and barely priced away from television.** Only the games on a
network carry real prop pricing; the rest of a Saturday comes back unpriced and is left out,
which is the correct outcome but means the section covers a fraction of the slate. Its game cap
is six for that reason and because a Saturday lists fifty games. It asks for the NFL's four
markets, since the games the ranking picks are the televised ones where those markets exist. Its wider volatility prior
(1.2 on the NFL's ratios) is reasoned from blowouts, benched starters and unknowable backfield
splits — it is not fitted. The feed's college player names collide more often than the NFL's
(two players of the same name across 130 teams), and a name is matched exactly rather than
fuzzily, so a collision shows up as an unmatched prop rather than a wrong price.

**The dispersion values are judgement, not fits.** The college football multiplier (1.2), every
NFL market's spread (for example 19 for passing yards, 13 for rushing yards, 16 for receiving
yards, as variance / mean) and the yardage spread floors (27% of the mean for passing yards,
45% rushing, 52% receiving) are reasoned from typical game logs. They have not been
fitted against realised results, because that needs a season of settled bets per league. Treat
them as starting points and retune them from the tracker.

**Minutes projections do not know league rules.** The rest and absence adjustments in the
game-log estimator were built for an 82-game NBA schedule. A football team playing weekly has a
different rest profile that is not modelled. Game-log import is basketball-only.

**NFL same-team correlation is invisible.** The feed does not say which team a player is on,
so a quarterback and his own receiver are linked only as players in the same game. That
understates a same-team stack and overstates opponents. NFL game script (a team that falls
behind throws more and runs less) is modelled only as a mild negative link between passing and
rushing yards in the same game.

**NFL touchdown scorer props are not priced.** Anytime and first-touchdown markets are yes/no
prices with no line, which this pipeline does not model.

**Correlation is otherwise league-blind, and the coefficients are structural priors.** Same-game
and same-player correlation is applied identically in every league, including between an NFL leg
and a college leg in the same section (they are never in the same game, so the effect is nil).
The coefficients are reasoned from how the sports work, not a covariance matrix fitted to
results, and the correlation dial in Settings now says so.

Per-league coefficients are **deliberately refused** rather than pending: there is no data to fit
them with, and inventing them is the thing this app exists not to do. What the deep NBA board did
change is which pairs are reachable. A combo market carries its components, so a player's points
against his pts+reb+ast is priced by expansion at about 0.92 rather than as two unrelated bets,
and the same holds for steals against steals+blocks (0.84) and points against field goals made
(0.86). Those are pinned by tests. The known soft spot is a pair nobody wrote a row for: made
field goals against made free throws sits at the 0.03 stranger default where the table's own rows
imply nearer 0.45. It is reachable only through a same-player stack, so it is pinned and named
here rather than guessed at.

A pick'em entry cannot hold a same-player pair at all — one leg per player, keyed on the player
and blind to the market — so this bites on the build screen's slips, where stacks are an explicit
toggle. There the **worst single pair** is now reported beside the average, because the average
cannot show it: one pair at 0.92 inside a six-leg slip averages to 0.06 and reads as
near-independent, which is also why the maximum-average-correlation constraint never bit on it.

**The pick'em ceiling is a prior about boards, not a measurement.** A prop whose every posted
line leaves the favoured side above the ceiling is left out of the pick'em targets, on the
reasoning that a pick'em app cannot offer a pick that lopsided and still pay a flat multiplier.
That threshold is judgement. It is now a dial in Settings, what it removes is listed by name on
screen, and a line PropLine shows an app actually posting overrides it — but with no pick'em feed
attached it is still a guess about what a board would offer.

**Browser storage was the binding constraint, and it took a pull off the screen.** Everything was
one localStorage blob, capped at roughly 5MiB. A pull stores every book's quote verbatim, so a
14-game NFL Sunday at eight books is 1.7-2.8MB of JSON, metered as 3.4-5.5MiB in UTF-16, and a
PropLine NBA pull of the whole board overflows the quota alone. The save shed load to fit and, on
such a slate, its last step dropped the pull that had just come in — from the state on screen,
not just from storage — so a successful pull read as "Nothing pulled yet". The state now lives in
IndexedDB, which is metered against the device's disk, one record per part, and a save that does
not fit is reported and never takes anything off the screen. What this does NOT do is make the
allocation smaller: a verbatim per-book cache is still what the engine needs to re-price without
spending credits. Where IndexedDB is unavailable the old blob is used, and a large slate there is
on screen until a reload and no longer.

**Whether an empty market costs a credit is unverified.** This app has said it does. Two
independent transcriptions of The Odds API docs give the per-event cost as unique markets
RETURNED times regions, which would mean trimming a market list saves nothing in credits. The
vendor's own documentation could not be reached from the environment this was checked in, so the
claim is marked unverified in the code with the one-request experiment that would settle it
(compare `x-requests-last` with and without a market the game does not post). No behaviour depends
on the answer: market lists are trimmed because an unpriced prop is a worse board.

**The depth ranking is a proxy, not a measurement.** How many books hang a spread on a game stands
in for how deep its player-prop market will be. They correlate, because both follow television,
but the only direct answer costs a credit per game and so defeats the purpose. The 21-point
blowout cut-off is judgement too, and on an early-season Saturday it can leave fewer games than
the cap — which is reported rather than quietly filled with worse ones.

**The calibration readout cannot fit the kickoff widening.** A settled leg's stored probability
already had the widening applied, so comparing it to the outcome measures the residual, not the
correction. Only the line history is independent of it, and that depends on something the app
cannot cause: a pull on game day for games already pulled midweek. Without those pairs the history
accumulates size and yields no fit.

**Splitting calibration thins the sample fast.** The headline number asks for 100 legs and the
band table refuses to highlight a gap under 20. Per competition and per market are therefore
separate tables rather than a grid, and the implied multiplier appears only at 25 legs — but even
so, a new competition will show nothing useful for a long time, and CFB legs mostly reach the
tracker through the screenshot path, which is the path where the competition is hardest to resolve.

**The NBA under margin is a prior, not a finding.** Its three points come from experience of
NBA unders, raised over an entry of four NBA unders that went two for four. Nothing here can show
from that why unders would trail their prices. The prices come from sportsbooks, which price both
sides, and the usual worry runs the other way: the public backs overs, so books shade overs. A
side that trails in your record could be trailing because of the lines chosen, the goblins on it
or the payouts it was played at, not the side itself. The margin cannot make that worse, because
it only removes unders. It can cost real plays, though, so it is set per league and shown on
the Today screen whenever it is in force. Set it to zero if your record says it is not earning
its keep.

**A result read off the ring is a colour, not a number.** The actual stat at the end of each
progress bar is not read, so a leg's margin of victory or defeat is not recorded, and a ring
the screen draws in some colour this has not seen reads as unsettled. The ring is measured on
PrizePicks screens only. Another app's entry screen will read every leg as open.

**The implied dispersion multiplier is a normal approximation.** It inverts a hit-rate gap into a
variance multiplier through the normal quantile, which is not how the count distributions the app
actually uses behave, and a yardage leg sitting on its coefficient-of-variation floor does not
scale with it at all. It is a direction and a rough size, and it is labelled that way on screen.
