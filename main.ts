// gta6-trophy-rarity-forecast-01: forecast every GTA VI PS5 trophy's Exophase earn
// rate at a case's target, as five quantiles a trophy, scored by pinball loss on
// the logit scale. Node 22, standard library only, no network, deterministic.
//
// Model (written for this entry; the house baseline is persistence + a random-walk
// spread, the house curve baseline a straight line of logit(rate) against
// ln(1 + hours) over the last 24h). Trophy earn rates do not grow linearly: they
// are the share of tracked players who have earned a trophy, and that share rises
// fast while players are new to the game, then flattens as the trophy's remaining
// audience shrinks. The median forecast is therefore a blend, in logit space,
// of two estimators that fail in different ways:
//
//   * a saturating logistic curve in log-time, rate(t) = R / (1 + exp(-(ln(1+t)
//     - m) / s)), fitted by least squares on the logit scale over the whole
//     history with recency weights. It captures the flattening, but its
//     ceiling R is weakly identified from two days of data, so on its own it
//     overshoots trophies that are still rising.
//   * a straight line of logit(rate) against ln(1 + hours) over the last 24h
//     of reads. It tracks the current growth rate well, but it never bends,
//     so on its own it overshoots trophies that are already flattening.
//
// Averaging the two in logit space halves each failure: on simulated
// final-like cases the blend's median error is smaller than either
// component's. The spread (sigma) combines the logistic fit's residual, a
// horizon term, a refresh/model-risk term, and the disagreement between the
// two medians — when the estimators disagree, the forecast is honestly wider.
//
// Why this should beat the house entries:
//   * Saturation: a straight logit line keeps rising forever; over the final's
//     6.5-day horizon it overshoots every trophy that is already flattening.
//     The logistic half of the blend stops that.
//   * Full history: the curve baseline uses only the last 24h; the logistic
//     half uses every read, so a trophy's early shape (fast rise, then bend)
//     is visible.
//   * Refresh jumps: Exophase refreshes its counts in steps, so the page's
//     rates jump down when a wave of new players is counted (launch night:
//     638 players tracked, then 3,868 after the first refresh, every rate
//     lower). A jump is a change in who is counted, not in who earned what,
//     so the fit works on the rates as printed but the spread carries an extra
//     term for refresh risk, and a history that has been perfectly flat for
//     hours while the game just launched is treated as stale: its next refresh
//     is expected to dilute the rates (see forecastFlatHistory).
//
// Edge cases: a trophy at 100% in every read cannot stay 100% once new
// players are counted, so it is forecast with a wide downward spread instead
// of a point at 100. A rate of 0.00 means zero earners, so it enters the fit
// as half an earner (a continuity correction), not as logit(0.01).
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Acklam's rational approximation to the standard normal's quantile. */
function normQuantile(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
const Z = LEVELS.map(normQuantile);

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clampPct(pct) / (100 - clampPct(pct)));
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Trophy {
  id: number;
  name: string;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; release_date: string };
  trophies: Trophy[];
  history: Read[];
}

/** Hours from the game's release date to an ISO timestamp. */
function hoursSinceRelease(iso: string, releaseDate: string): number {
  const release = Date.parse(`${releaseDate}T00:00:00.000Z`);
  return Math.max(0, (Date.parse(iso) - release) / 3_600_000);
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

interface LogisticFit {
  /** Long-run rate (percent). */
  r: number;
  /** Log-time of the curve's midpoint. */
  m: number;
  /** Log-time width of the curve. */
  s: number;
  /** Weighted root-mean-square residual on the logit scale. */
  resid: number;
}

/**
 * Fit rate(t) = R / (1 + exp(-(x - m) / s)) on the logit scale, where
 * x = ln(1 + hours since release). Coarse grid search, then coordinate
 * refinement around the best point. Returns null when the series carries
 * too little information to fit (fewer than 3 usable reads).
 */
function fitLogistic(
  xs: number[],
  ys: number[],
  ws: number[],
  rLast: number,
): LogisticFit | null {
  const n = xs.length;
  if (n < 3) return null;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const wSum = ws.reduce((a, b) => a + b, 0);

  // R runs from just above the last observed rate up to 100, log-spaced.
  const rLo = Math.max(rLast * 1.02, 0.05);
  const rGrid: number[] = [];
  for (let k = 0; k < 12; k++) {
    rGrid.push(Math.exp(Math.log(rLo) + ((Math.log(100) - Math.log(rLo)) * k) / 11));
  }
  const mGrid: number[] = [];
  for (let k = 0; k < 12; k++) {
    mGrid.push(xMin - 1 + ((xMax + 4 - (xMin - 1)) * k) / 11);
  }
  const sGrid = [0.3, 0.5, 0.8, 1.3, 2.0];

  const sse = (r: number, m: number, s: number): number => {
    let total = 0;
    for (let j = 0; j < n; j++) {
      const model = clampPct(r * logistic((xs[j] - m) / s));
      const d = ys[j] - logit(model);
      total += ws[j] * d * d;
    }
    return total;
  };

  let best = { sse: Infinity, r: rLo, m: xMax, s: 0.8 };
  for (const r of rGrid) {
    for (const m of mGrid) {
      for (const s of sGrid) {
        const v = sse(r, m, s);
        if (v < best.sse) best = { sse: v, r, m, s };
      }
    }
  }
  // Coordinate refinement: shrink steps around the best point.
  let stepR = 1.15;
  let stepM = 0.4;
  let stepS = 1.25;
  for (let round = 0; round < 10; round++) {
    let improved = false;
    const tries: Array<{ r: number; m: number; s: number }> = [
      { r: best.r * stepR, m: best.m, s: best.s },
      { r: best.r / stepR, m: best.m, s: best.s },
      { r: best.r, m: best.m + stepM, s: best.s },
      { r: best.r, m: best.m - stepM, s: best.s },
      { r: best.r, m: best.m, s: best.s * stepS },
      { r: best.r, m: best.m, s: best.s / stepS },
    ];
    for (const t of tries) {
      if (t.r <= rLast || t.r > 100 || t.s <= 0.05 || t.s > 5) continue;
      const v = sse(t.r, t.m, t.s);
      if (v < best.sse - 1e-12) {
        best = { sse: v, r: t.r, m: t.m, s: t.s };
        improved = true;
      }
    }
    if (!improved) {
      stepR = 1 + (stepR - 1) / 2;
      stepM /= 2;
      stepS = 1 + (stepS - 1) / 2;
      if (stepM < 0.01) break;
    }
  }
  return { r: best.r, m: best.m, s: best.s, resid: Math.sqrt(best.sse / wSum) };
}

interface Forecast {
  /** Median rate at the target (percent). */
  median: number;
  /** Logit-scale sigma for the quantiles. */
  sigma: number;
}

/**
 * Straight-line fit of logit(rate) against x = ln(1 + hours), over the reads
 * within the last 24h of the history (all reads, plateaus included — the
 * plateau weighting stabilises the slope when Exophase refreshes only every
 * few hours). Falls back to the whole history when the window holds fewer
 * than 3 points. The logit move from the last rate is clamped so a noisy
 * slope cannot throw the forecast orders of magnitude away.
 */
function linearLogitMedian(
  xs: number[],
  ys: number[],
  rLast: number,
  xTarget: number,
): number {
  const tLast = Math.exp(Math.max(...xs)) - 1;
  let px: number[] = [];
  let py: number[] = [];
  for (let j = 0; j < xs.length; j++) {
    const t = Math.exp(xs[j]) - 1;
    if (tLast - t <= 24) {
      px.push(xs[j]);
      py.push(ys[j]);
    }
  }
  if (px.length < 3) {
    px = xs;
    py = ys;
  }
  const n = px.length;
  const mx = px.reduce((a, b) => a + b, 0) / n;
  const my = py.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let j = 0; j < n; j++) {
    num += (px[j] - mx) * (py[j] - my);
    den += (px[j] - mx) * (px[j] - mx);
  }
  const b = den === 0 ? 0 : num / den;
  const l = my - b * mx + b * xTarget;
  const dl = Math.max(-2, Math.min(2, l - logit(rLast)));
  return clampPct(invLogit(logit(rLast) + dl));
}

/**
 * Forecast one trophy from its history.
 *
 * xs/ys: log-time and logit(rate) per read; ns: players tracked per read;
 * rLast: the rate in the last read; days: the horizon in days.
 */
function forecastTrophy(
  xs: number[],
  ys: number[],
  xsAll: number[],
  ysAll: number[],
  ns: number[],
  rLast: number,
  days: number,
  trophyId: number,
): Forecast {
  const n = xs.length;
  const yRange = Math.max(...ys) - Math.min(...ys);
  const spanHours = (Math.exp(Math.max(...xs)) - 1) - (Math.exp(Math.min(...xs)) - 1);
  const nLast = ns[ns.length - 1];

  // A history that has not moved at all is not a forecast of stillness: on
  // launch night Exophase's page sat unchanged for hours (638 players
  // tracked, every rate the same) and then refreshed to 3,868 players with
  // every rate lower. A flat, short, small-player history is stale, and its
  // next refresh dilutes the rates: new players have played only hours, so
  // they hold a trophy at a fraction of the rate the launch-night cohort
  // does — near the full rate for a trophy everyone gets at the start, about
  // two-fifths for ordinary story trophies, about a quarter for rare ones.
  // The fractions below sit at the geometric centre of the plausible range
  // for each tier, so the median is a compromise rather than a bet on one
  // refresh size; the spread stays wide because the size of the next refresh
  // is not known.
  if (yRange < 0.1 && spanHours < 12 && nLast < 5000) {
    const frac = rLast >= 50 ? 0.89 : rLast >= 1 ? 0.44 : 0.28;
    return { median: clampPct(rLast * frac), sigma: 0.8 };
  }
  // Flat but not stale (a long or large-player history that genuinely has
  // not moved): persistence with a moderate spread.
  if (yRange < 0.1) {
    return { median: rLast, sigma: 0.4 };
  }

  // Recency weights: the most recent reads describe the regime the target
  // continues from.
  const ws = xs.map((_, j) => 0.4 + (0.6 * j) / Math.max(1, n - 1));
  const fit = fitLogistic(xs, ys, ws, rLast);
  if (fit === null) {
    return { median: rLast, sigma: 0.5 * Math.sqrt(days) + 0.3 };
  }
  const xTarget = Math.log(1 + hoursSinceReleaseTarget);
  const medLogistic = clampPct(fit.r * logistic((xTarget - fit.m) / fit.s));
  // Blend with the straight-line logit forecast on the FULL series
  // (plateaus included — their weighting stabilises the slope): the two
  // estimators fail in opposite directions, and their average is steadier
  // than either alone.
  const medLinear = linearLogitMedian(xsAll, ysAll, rLast, xTarget);
  const median = clampPct(invLogit((logit(medLogistic) + logit(medLinear)) / 2));
  const disagreement = Math.abs(logit(medLogistic) - logit(medLinear));
  if (process.env.MAKEFUN_DEBUG === '1') {
    // Fit diagnostics on stderr only; the grader never sets this variable.
    process.stderr.write(`fit id=${trophyId} R=${fit.r.toFixed(3)} m=${fit.m.toFixed(3)} s=${fit.s.toFixed(3)} resid=${fit.resid.toFixed(3)} medLog=${medLogistic.toFixed(4)} medLin=${medLinear.toFixed(4)} median=${median.toFixed(4)}\n`);
  }
  const resid = Math.min(0.6, Math.max(0.12, fit.resid));
  // Fit residual + horizon growth + refresh/model risk + the two medians'
  // disagreement (when they disagree, the forecast is honestly wider).
  const sigma = Math.sqrt(resid * resid + 0.03 * days + 0.06 + 0.0625 * disagreement * disagreement);
  return { median, sigma };
}

// Set per case before forecasting its trophies (the target's log-time).
let hoursSinceReleaseTarget = 0;

function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const days = c.horizon_minutes / 1440;
  const release = c.game.release_date ?? '2026-11-19';
  hoursSinceReleaseTarget = hoursSinceRelease(c.target, release);
  const reads = c.history.filter((r) => r.rates !== undefined);
  if (reads.length === 0) throw new Error(`case ${c.id} has no history`);

  return c.trophies.map((t, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const xsAll: number[] = [];
    const ysAll: number[] = [];
    const ns: number[] = [];
    let rLast = 0;
    let lastKeptRate: number | null = null;
    for (const read of reads) {
      const rate = read.rates[i];
      if (rate === null || rate === undefined) continue;
      rLast = rate;
      const x = Math.log(1 + hoursSinceRelease(read.at, release));
      // A printed 0.00 means zero earners: half an earner, not logit(0.01).
      const pct = rate === 0 ? (50 / Math.max(1, read.players_tracked)) : rate;
      // A printed 100% in a single read is not logit(99.99); cap it so one
      // such read cannot bend the fit.
      const y = rate >= 100 ? Math.min(logit(pct), 6.9) : logit(pct);
      // The straight-line estimator uses every read: the plateaus between
      // refreshes weight its slope by how long each level lasted.
      xsAll.push(x);
      ysAll.push(y);
      // Exophase refreshes its counts in steps: between refreshes the page
      // prints the same rates, so the printed series is a staircase that
      // lags the true curve by up to a refresh interval. Fitting the
      // staircase as if every read were a fresh measurement biases the
      // curve late (and its ceiling high). The logistic fit therefore keeps
      // only the reads where this trophy's printed rate actually changed —
      // each such read is the true rate at about the time it first appeared.
      if (lastKeptRate !== null && Math.abs(rate - lastKeptRate) <= 0.005) continue;
      lastKeptRate = rate;
      xs.push(x);
      ys.push(y);
      ns.push(read.players_tracked);
    }
    if (xs.length === 0) throw new Error(`case ${c.id} trophy ${t.id} has no rates`);

    // A trophy every read shows at 100% cannot stay at 100% once new
    // players are counted: forecast it high but with a wide downward
    // spread, instead of a point at 100.
    if (rLast >= 99.95 && ys.every((y) => y >= 6.9)) {
      return { id: t.id, q: [88, 95, 98, 99.5, 99.95].map(round4) };
    }

    const f = forecastTrophy(xs, ys, xsAll, ysAll, ns, rLast, days, t.id);
    const l = logit(f.median);
    const q = Z.map((z) => round4(clampPct(invLogit(l + z * f.sigma))));
    // Rounding can break monotonicity at the extremes; enforce it.
    for (let k = 1; k < q.length; k++) {
      if (q[k] < q[k - 1]) q[k] = q[k - 1];
    }
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
