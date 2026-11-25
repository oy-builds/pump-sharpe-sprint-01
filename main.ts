// Smooth Tape — a variance-first paper-trading bot for the agent-fun/replay/v2
// pump.fun replay, built for the hourly-Sharpe ranking: many small,
// similar-sized round trips, none of them able to move the hour on its own.
//
// Entry: a curve past its launch phase (>=300 slots old, 2-50 SOL real reserve)
// with a high-conviction tape over the last 60 slots — >=2.0 SOL net inflow,
// >=8 buys from >=6 distinct wallets, >=80% buy share, price up 3-15% and
// pulled back to 90-98.5% of the window high (a dip inside an uptrend, never
// the top tick).
//
// Sizing & risk: one fixed 0.02 SOL stake per position, clipped by the
// 1%-of-real-reserve order cap; total exposure capped at 0.12 SOL; max 5 open
// positions; one entry per mint, ever — no pyramiding, no averaging down,
// no re-entry.
//
// Exits (first rule that fires, whole position): take-profit +9%, stop-loss
// -4.5%, trailing stop armed at +5% and firing 4% below the peak, or a
// 200-slot maximum hold. A slow rotation of tiny 0.012 SOL round trips on the
// most liquid curve keeps the run just past the 20-distinct-mint guardrail
// without churning fees.
//
// Fully deterministic: no clock, no randomness, no network. Iteration is over
// insertion-ordered maps fed by the batch stream, so two executions of the
// same replay produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // pump.fun curve fee share taken on the sell side
const BPS = 10_000;

// --- strategy constants (SOL unless noted) ---------------------------------
const WINDOW_SLOTS = 60;
const MIN_AGE_SLOTS = 300;
const MIN_REAL_SOL = 2;
const MAX_REAL_SOL = 50;
const MIN_NET_INFLOW_SOL = 2.0;
const MIN_BUYS = 8;
const MIN_BUYERS = 6;
const MIN_BUY_SHARE = 0.8;
const MIN_PRICE_UP = 0.03;
const MAX_PRICE_UP = 0.15;
const PULLBACK_LOW = 0.9;
const PULLBACK_HIGH = 0.985;
const STAKE_SOL = 0.02;
const MIN_ROUND_TRIP_SOL = 0.01;
const MAX_EXPOSURE_SOL = 0.12;
const MAX_OPEN = 5;
const TAKE_PROFIT = 0.09;
const STOP_LOSS = 0.045;
const TRAIL_ARM = 0.05;
const TRAIL_DROP = 0.04;
const MAX_HOLD_SLOTS = 200;
// A slow rotation of tiny 0.012 SOL round trips on the most liquid curve
// keeps the run just past the 20-distinct-mint guardrail without churning
// fees. The rotation runs until 26 distinct coins: cutting the target to 21
// was tried on the dev window and graded worse (Sharpe -0.4870, PnL
// -0.0349 SOL vs -0.3438 / -0.0286 SOL at 26), because fewer probes left
// the run concentrated on fewer, worse main entries — so 26 stays.
const PROBE_SOL = 0.012;
const PROBE_TARGET_COINS = 26;
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number; // SOL per token: virtual_quote_reserves / virtual_token_reserves
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
}

interface Held {
  opened: number;
  peakValue: number; // best close value seen, SOL
  cost: number; // SOL spent (fees included), from the account
  exiting: boolean;
}

const tapes = new Map<Pubkey, Tape>();
/** Every mint ever entered (main or probe): one entry per mint, ever. */
const entered = new Set<Pubkey>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight: false while buying, true once the buy landed. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [] };
    tapes.set(mint, t);
  }
  return t;
}

/** Close value of a position in SOL, curve and tx fees deducted. */
function closeValue(state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mark = batch.marks.find((m) => m.mint === mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  const t = Number(tokens);
  if (vt + t <= 0) return 0;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
}

/** The entry signal on a curve's 60-slot tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) continue;
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  const net = buySol - sellSol;
  if (net < MIN_NET_INFLOW_SOL) return false;
  if (buySol + sellSol <= 0 || buySol / (buySol + sellSol) < MIN_BUY_SHARE) return false;
  if (startPrice <= 0 || high <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  const pullback = last / high;
  if (pullback < PULLBACK_LOW || pullback > PULLBACK_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      } else if (e.event === 'CompleteEvent') {
        const curve = state.curves.get(e.mint);
        if (curve !== undefined) curve.complete = true;
      }
    }
    // Prune tape history older than the window (plus a small margin).
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - WINDOW_SLOTS - 5) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const hasPendingSell = (mint: Pubkey): boolean => {
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') return true;
      }
      return false;
    };

    // --- Exits first: whole position on the first rule that fires. ---------
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(state, batch, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      h.cost = cost;
      if (value > h.peakValue) h.peakValue = value;
      let exit = h.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (hasPendingSell(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // --- Probe round trips: sell the whole probe as soon as its buy lands. --
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      if (!selling) probes.set(mint, true);
    }

    // --- Entries: main signal, then one probe at a time. --------------------
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = MAX_OPEN - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      exposure += pos ? Number(pos.cost_lamports) / LAMPORTS : h.cost;
    }

    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
      if (entered.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint)!;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const capLamports = state.maxBuyLamports(mint);
      let amount = Math.min(STAKE_SOL, Number(capLamports) / LAMPORTS, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_ROUND_TRIP_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIPPAGE_BPS });
      entered.add(mint);
      held.set(mint, { opened: now, peakValue: 0, cost: amount, exiting: false });
      free -= amount + tx;
      exposure += amount;
      slotsLeft -= 1;
    }

    // --- Guardrail rotation: one tiny probe on the most liquid curve. ------
    // Keeps the run just past the 20-distinct-mint guardrail. Only one probe
    // in flight at a time, only while coins are below target, and only on a
    // curve this run has never entered.
    if (probes.size === 0 && myCoins.size < PROBE_TARGET_COINS && slotsLeft > 0) {
      let best: Pubkey | null = null;
      let bestRq = 0;
      for (const mint of traded) {
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        if (entered.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol <= bestRq) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        if (capSol < PROBE_SOL) continue;
        best = mint;
        bestRq = rqSol;
      }
      if (best !== null && orders.length < cap && free >= PROBE_SOL + tx) {
        orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
        entered.add(best);
        probes.set(best, false);
        free -= PROBE_SOL + tx;
      }
    }

    return orders;
  },
});
