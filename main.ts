// Pump.fun Sharpe Sprint — Cleanest: a low-variance reversion bot.
//
// Idea: buy the dip after a real run-up, only while buy flow is still
// dominant and the dip is stabilising, then exit on a small, steady
// take-profit, a tight stop, a tight trailing stop, or a stale timer.
// Small tranches, few trades, tiny drawdown: the metric is hourly Sharpe
// on a 6-hour forward window, and the prize still needs net PnL > 0.
//
// Pure function of the batches: no clock, no randomness, no environment.
// Deterministic: two runs on the same data produce byte-identical replies.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tunables

/** SOL per buy tranche. */
const TRANCHE_SOL = 0.03;
/** Max buys per mint (pyramid only while the price rises above entry). */
const MAX_BUYS_PER_MINT = 2;
/** Second buy only when price is at least this far above average entry. */
const PYRAMID_MIN_GAIN = 0.03;
/** Entry needs at least this many trades seen on the mint. */
const MIN_TRADES = 20;
/** Ring buffer of recent trades per mint. */
const MAX_TRADES = 80;
/** Run-up: window high must be at least this multiple of the oldest price. */
const RUNUP_MIN = 1.25;
/** Dip: price must be at most this fraction of the window high. */
const DIP_MAX = 0.85;
/** Newest-half buy SOL must be at least this multiple of newest-half sell SOL. */
const FLOW_MIN = 1.5;
/** Distinct buyers in the buffer required for entry. */
const MIN_BUYERS = 4;
/** Stabilisation: price must have bounced at least this far off the window low. */
const BOUNCE_MIN = 0.02;
/** Of the last 5 trades, at least this many must be buys. */
const RECENT_BUYS_MIN = 3;
/** Real SOL reserve floor: below it the 1% order cap makes a buy too small
 *  for its 105k-lamport transaction fee. */
const MIN_REAL_SOL = 2;
/** Exits (fractions of average entry price). */
const TAKE_PROFIT = 0.16;
const STOP_LOSS = -0.08;
/** Trailing stop: sell when price falls this far below the peak, once the
 *  peak is at least TRAIL_PEAK_MIN above entry. */
const TRAIL_DROP = 0.08;
const TRAIL_PEAK_MIN = 0.06;
/** Stale exit: sell after this many slots without TP/SL/trailing. */
const STALE_SLOTS = 1200;
/** Slippage allowance on fills, in bps. */
const SLIPPAGE_BPS = 500;

// ------------------------------------------------------------------ per-mint tape

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  /** SOL moved, as a float (sol_amount lamports / 1e9). */
  sol: number;
  user: string;
  /** Price (SOL per token) right after this trade. */
  price: number;
}

interface Tape {
  trades: TapeTrade[];
  high: number;
  low: number;
}

const tapes = new Map<string, Tape>();

/** Per-held-mint state, kept across batches. */
interface Held {
  peak: number;
  buys: number;
  entrySlot: number;
}
const held = new Map<string, Held>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function tapeFor(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { trades: [], high: 0, low: Number.POSITIVE_INFINITY };
    tapes.set(mint, t);
  }
  return t;
}

// ------------------------------------------------------------------ entry signal

function entrySignal(state: BotState, mint: string): boolean {
  const t = tapes.get(mint);
  if (t === undefined || t.trades.length < MIN_TRADES) return false;
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  // Real-reserve floor so the 1% cap still allows a useful buy.
  if (Number(curve.real_quote_reserves) < MIN_REAL_SOL * 1_000_000_000) return false;

  const first = t.trades[0];
  const last = t.trades[t.trades.length - 1];
  const now = last.price;
  if (now <= 0) return false;
  // A real run-up happened, then the price fell off its high.
  if (t.high < RUNUP_MIN * first.price) return false;
  if (now > DIP_MAX * t.high) return false;
  // The dip is stabilising: bounced off the low, recent trades mostly buys.
  if (now < (1 + BOUNCE_MIN) * t.low) return false;
  const recent = t.trades.slice(-5);
  if (recent.filter((x) => x.isBuy).length < RECENT_BUYS_MIN) return false;

  // Buy flow still dominant in the newest half of the tape.
  const half = Math.floor(t.trades.length / 2);
  let buyNew = 0;
  let sellNew = 0;
  const buyers = new Set<string>();
  for (let i = half; i < t.trades.length; i++) {
    const tr = t.trades[i];
    if (tr.isBuy) {
      buyNew += tr.sol;
      buyers.add(tr.user);
    } else {
      sellNew += tr.sol;
    }
  }
  if (buyers.size < MIN_BUYERS) return false;
  if (buyNew < FLOW_MIN * Math.max(sellNew, 1e-9)) return false;

  return true;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // 0) A buy that was rejected/failed never becomes a position: clear the
    //    held-state for it (unless another buy for the mint is still pending).
    for (const f of batch.fills) {
      if (f.side !== 'buy' || f.status === 'filled') continue;
      if (state.positions.has(f.mint)) continue;
      const stillPending = [...state.pending.values()].some(
        (p) => p.order.side === 'buy' && p.order.mint === f.mint,
      );
      if (!stillPending) held.delete(f.mint);
    }

    // 1) Fold this batch's trades into the tapes.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (p <= 0) continue;
      const t = tapeFor(e.mint);
      t.trades.push({
        slot: e.slot,
        isBuy: e.is_buy,
        sol: Number(BigInt(e.sol_amount)) / 1_000_000_000,
        user: e.user,
        price: p,
      });
      if (t.trades.length > MAX_TRADES) t.trades.splice(0, t.trades.length - MAX_TRADES);
      if (p > t.high) t.high = p;
      if (p < t.low) t.low = p;
      touched.add(e.mint);
    }

    // 2) Drop held-state for positions that are gone (sold / flattened /
    //    completed by the harness) — but keep it while a buy is still pending.
    for (const mint of [...held.keys()]) {
      if (state.positions.has(mint)) continue;
      const buyPending = [...state.pending.values()].some(
        (p) => p.order.side === 'buy' && p.order.mint === mint,
      );
      if (!buyPending) held.delete(mint);
    }

    const orders: OrderInput[] = [];
    const tranche = BigInt(Math.round(TRANCHE_SOL * 1_000_000_000));

    // 3) Exits first: every held mint, priced from the latest marks.
    for (const mark of batch.marks) {
      const pos = state.positions.get(mark.mint);
      if (pos === undefined) continue;
      const h = held.get(mark.mint);
      if (h === undefined) continue;
      const price = priceOf(BigInt(mark.virtual_quote_reserves), BigInt(mark.virtual_token_reserves));
      if (price <= 0) continue;
      if (price > h.peak) h.peak = price;
      const avgEntry = Number(pos.cost_lamports) / Number(pos.token_amount);
      if (avgEntry <= 0) continue;
      const ret = price / avgEntry - 1;
      const peakRet = h.peak / avgEntry - 1;
      const stale = state.slot - h.entrySlot > STALE_SLOTS;
      const hitTp = ret >= TAKE_PROFIT;
      const hitSl = ret <= STOP_LOSS;
      const hitTrail = peakRet >= TRAIL_PEAK_MIN && price <= (1 - TRAIL_DROP) * h.peak;
      if (hitTp || hitSl || hitTrail || stale) {
        orders.push({
          side: 'sell',
          mint: mark.mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // 4) Entries: only mints that traded in this batch.
    const soldThisBatch = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
    for (const mint of touched) {
      if (soldThisBatch.has(mint)) continue;
      if (state.positions.has(mint)) {
        // Pyramid: one extra tranche while the price rises above entry.
        const h = held.get(mint);
        const pos = state.positions.get(mint);
        if (h === undefined || pos === undefined || h.buys >= MAX_BUYS_PER_MINT) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const avgEntry = Number(pos.cost_lamports) / Number(pos.token_amount);
        if (avgEntry <= 0 || price < (1 + PYRAMID_MIN_GAIN) * avgEntry) continue;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
        const cap = state.maxBuyLamports(mint);
        const size = tranche < cap ? tranche : cap;
        if (size <= 0n) continue;
        if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
        h.buys += 1;
        continue;
      }
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      if (held.has(mint)) continue; // a buy for this mint is already pending
      if (!entrySignal(state, mint)) continue;
      const cap = state.maxBuyLamports(mint);
      const size = tranche < cap ? tranche : cap;
      if (size <= 0n) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      // Peak starts at the decision-time price; entrySlot is this batch's slot.
      const curve = state.curves.get(mint);
      const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      held.set(mint, { peak: price, buys: 1, entrySlot: state.slot });
    }

    return orders;
  },
});
