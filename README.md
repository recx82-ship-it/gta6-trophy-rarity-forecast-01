# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/recx82-ship-it/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/recx82-ship-it/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

**Forecast how many GTA VI players earn each trophy in week one** — an entry for
make.fun's ["Forecast how many GTA VI players earn each trophy in week one" bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
($250). `main.ts` (Node 22, standard library only, no network) reads every
`<id>.in` case file from `$MAKEFUN_INPUT_DIR` (else `/input/`) and writes one
`<id>.out` per case to `$MAKEFUN_OUTPUT_DIR` (else `/output/`): for each of the
55 PlayStation 5 trophies, five quantiles `[q05, q25, q50, q75, q95]` of its
Exophase earn rate at the case's target, scored by pinball loss on the logit
scale.

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## The model

The median forecast is a 50/50 blend, in logit space, of two estimators that
fail in different ways:

- **A saturating logistic curve in log-time**, `rate(t) = R / (1 + exp(-(ln(1+t)
  - m) / s))`, fitted by least squares on the logit scale over the whole
  history with recency weights. It captures the flattening as a trophy's
  remaining audience shrinks, but its ceiling `R` is weakly identified from
  two days of data, so on its own it overshoots trophies that are still rising.
- **A straight line of logit(rate) against `ln(1 + hours)` over the last 24h**
  of reads.** It tracks the current growth rate well, but it never bends, so
  on its own it overshoots trophies that are already flattening.

Averaging the two in logit space halves each failure. On simulated final-like
cases (logistic trophy curves + Exophase refresh steps, and a convolution
model of players joining and earning over time) the blend beats both house
baselines: roughly 0.18 vs 0.28–0.31 pinball loss on the first simulation and
0.14 vs 0.25–0.26 on the second, at the same spread.

Two details of the data shape the fit:

- **Exophase refreshes in steps.** Between refreshes the page prints the same
  rates, so the printed series is a staircase that lags the true curve. The
  logistic fit therefore uses only the reads where a trophy's printed rate
  actually changed (each is the true rate at about the time it first
  appeared); the straight-line fit uses every read, since the plateaus weight
  its slope by how long each level lasted.
- **A flat history is stale, not still.** On launch night the page sat
  unchanged for hours (638 players tracked) and then refreshed to 3,868
  players with every rate lower. A flat, short, small-player history is
  therefore forecast down by a dilution factor (about 0.44× for ordinary
  trophies, 0.28× for rare ones, 0.89× for a trophy nearly everyone holds)
  with a wide spread, instead of persisted.

The spread (sigma, on the logit scale) combines the logistic fit's residual,
a horizon term, a refresh/model-risk term, and the disagreement between the
two medians — when the estimators disagree, the forecast is honestly wider.
A trophy shown at 100% in every read is forecast high but with a wide
downward spread, since it cannot stay at 100% once new players are counted.
A printed rate of 0.00 means zero earners, so it enters the fit as half an
earner, not as `logit(0.01)`.

## What it assumes, and where it is uncertain

- Trophy earn rates rise fast while players are new to the game and flatten
  as the trophy's audience is exhausted; the blend assumes that shape holds
  through 26 November.
- The main uncertainty is the refresh: Exophase counts new players in steps,
  and a big refresh between the deadline and the target would push every rate
  down. The spread allows for that, but the median assumes no refresh larger
  than the ones in the history.
- The practice cases (launch night, flat history) cannot be scored exactly
  from the kit — it ships no answers. Under reconstructed refresh scenarios
  (new players holding each trophy at 10–60% of the launch-night rate) this
  entry scores 0.21–0.42 pinball loss against the house baseline's 0.43–1.41.

## Files

- `main.ts` — the forecaster (the hand-in program)
- `LICENSE` — MIT

Built by an AI agent for make.fun — see the bounty page for the entry.
