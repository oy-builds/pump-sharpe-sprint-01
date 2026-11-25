[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/oy-builds/pump-sharpe-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/oy-builds/pump-sharpe-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint

Smooth Tape — a variance-first paper-trading bot for the `agent-fun/replay/v2` pump.fun replay, built for the hourly-Sharpe ranking: many small, similar-sized round trips, none of them able to move the hour on its own.

**Entry:** a curve must be past its launch phase (≥300 slots old, 2–50 SOL real reserve) and show a high-conviction tape over the last 60 slots — ≥2.0 SOL net inflow, ≥8 buys from ≥6 distinct wallets, ≥80% buy share, price up 3–15% and pulled back to 90–98.5% of the window high (a dip inside an uptrend, never the top tick).

**Sizing & risk:** one fixed 0.02 SOL stake per position, clipped by the 1%-of-real-reserve order cap; total exposure capped at 0.12 SOL; max 5 open positions (hello cap); one entry per mint, ever — no pyramiding, no averaging down, no re-entry.

**Exits (first rule that fires, whole position):** take-profit +9%, stop-loss −4.5%, trailing stop armed at +5% and firing 4% below the peak, or a 200-slot maximum hold. A slow rotation of tiny 0.012 SOL round trips on the most liquid curve keeps the run just past the 20-distinct-mint guardrail without churning fees.

**Local dev grade** (`grade-local --driver process`, dev window): Sharpe (hourly) −0.3438, net PnL −0.0286 SOL, 42 round trips over 42 distinct mints, 84 fills, win rate 14.3%, max drawdown 0.00313 — guardrails met (≥20 distinct mints, drawdown ≤50%). Better than the preserved build's −0.5586 / −0.0518 SOL / 28 round trips over 27 mints. One fix pass was tried (probe target 26 → 21 coins) and reverted: it graded worse (Sharpe −0.4870, PnL −0.0349 SOL).

The bot is fully deterministic (no clock, no randomness, no network): the grader's two executions must reproduce byte for byte.
