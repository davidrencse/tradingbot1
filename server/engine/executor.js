import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Round a quantity DOWN to the market's step size and render it with exactly
// the decimals Binance expects for that market.
export function floorToStep(q, step) {
  if (!(step > 0)) return { value: q, text: String(q) };
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const v = Math.floor(q / step + 1e-9) * step;
  return { value: Number(v.toFixed(decimals)), text: v.toFixed(decimals) };
}

export function roundToTick(p, tick) {
  if (!(tick > 0)) return String(p);
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return (Math.round(p / tick) * tick).toFixed(decimals);
}

// Paper venue: fills against the LIVE book at the moment each order would
// land, with IOC-limit semantics. A price that moved away means no fill; depth
// thinner than the order means a partial fill. Nothing is invented.
export class PaperVenue {
  constructor(scanner, { latencyMs, feeBps }) {
    this.s = scanner;
    this.latencyMs = latencyMs;
    this.fee = 1 - feeBps / 1e4;
  }

  async fillIoc(leg, inAmt, limit) {
    await sleep(this.latencyMs);
    const s = this.s;
    const m = s.markets[leg.m];
    if (leg.side === 'BUY') {
      const p = s.ask[leg.m];
      const qty = floorToStep(inAmt / limit, m.step).value;
      if (!(p > 0) || p > limit || qty <= 0) return { status: 'EXPIRED', price: p, qty: 0, spent: 0, received: 0 };
      const fill = Math.min(qty, s.askQty[leg.m]);
      return { status: fill < qty ? 'PARTIALLY_FILLED' : 'FILLED', price: p, qty: fill, spent: fill * p, received: fill * this.fee };
    }
    const p = s.bid[leg.m];
    const qty = floorToStep(inAmt, m.step).value;
    if (!(p > 0) || p < limit || qty <= 0) return { status: 'EXPIRED', price: p, qty: 0, spent: 0, received: 0 };
    const fill = Math.min(qty, s.bidQty[leg.m]);
    return { status: fill < qty ? 'PARTIALLY_FILLED' : 'FILLED', price: p, qty: fill, spent: fill, received: fill * p * this.fee };
  }

  // Paper assumes the intermediate inventory parallel execution needs is on hand.
  available() { return Infinity; }

  // Market order back to the home asset at whatever the book shows now.
  async unwind(asset, amount, marketIdx) {
    await sleep(this.latencyMs);
    const s = this.s;
    const m = s.markets[marketIdx];
    if (m.base === asset) {
      const p = s.bid[marketIdx];
      return { price: p, received: amount * p * this.fee };
    }
    const p = s.ask[marketIdx];
    return { price: p, received: (amount / p) * this.fee };
  }

  // Market order that restores `amount` of `asset`, paid for in home.
  async buyBack(asset, amount, marketIdx) {
    await sleep(this.latencyMs);
    const s = this.s;
    const m = s.markets[marketIdx];
    if (m.base === asset) {
      const p = s.ask[marketIdx];
      return { price: p, cost: (amount / this.fee) * p };
    }
    const p = s.bid[marketIdx];
    return { price: p, cost: amount / (p * this.fee) };
  }
}

// Live venue: the same contract, backed by real signed orders.
export class LiveVenue {
  constructor(scanner, rest) {
    this.s = scanner;
    this.rest = rest;
    this.balances = new Map();
  }

  async refreshBalances() {
    const acct = await this.rest.account();
    this.balances = new Map(acct.balances.map((b) => [b.asset, Number(b.free)]));
    return this.balances;
  }

  available(asset) { return this.balances.get(asset) ?? 0; }
  afterTrade() { this.refreshBalances().catch(() => {}); }

  async fillIoc(leg, inAmt, limit) {
    const m = this.s.markets[leg.m];
    const qty = floorToStep(leg.side === 'BUY' ? inAmt / limit : inAmt, m.step);
    if (qty.value <= 0 || qty.value < m.minQty || qty.value * limit < m.minNotional) {
      return { status: 'REJECTED_LOCAL', price: limit, qty: 0, spent: 0, received: 0, note: 'below lot/notional minimum' };
    }
    const r = await this.rest.order({
      symbol: m.symbol, side: leg.side, type: 'LIMIT', timeInForce: 'IOC',
      quantity: qty.text, price: roundToTick(limit, m.tick),
    });
    return this.#settle(r, m, leg.side);
  }

  async unwind(asset, amount, marketIdx) {
    const m = this.s.markets[marketIdx];
    const params = { symbol: m.symbol, type: 'MARKET' };
    if (m.base === asset) Object.assign(params, { side: 'SELL', quantity: floorToStep(amount, m.step).text });
    else Object.assign(params, { side: 'BUY', quoteOrderQty: (Math.floor(amount * 1e6) / 1e6).toFixed(6) });
    const r = await this.rest.order(params);
    const s = this.#settle(r, m, params.side);
    return { price: s.price, received: s.received };
  }

  async buyBack(asset, amount, marketIdx) {
    const m = this.s.markets[marketIdx];
    const params = { symbol: m.symbol, type: 'MARKET' };
    // Base asset: buy the quantity. Quote asset: sell enough home to receive it.
    if (m.base === asset) Object.assign(params, { side: 'BUY', quantity: floorToStep(amount * 1.001, m.step).text });
    else Object.assign(params, { side: 'SELL', quoteOrderQty: (Math.ceil(amount * 1.001 * 1e6) / 1e6).toFixed(6) });
    const r = await this.rest.order(params);
    const st = this.#settle(r, m, params.side);
    // BUY spends quote (home); SELL spends base (home).
    return { price: st.price, cost: st.spent };
  }

  #settle(r, m, side) {
    const qty = Number(r.executedQty);
    const quote = Number(r.cummulativeQuoteQty);
    let commBase = 0, commQuote = 0;
    for (const f of r.fills ?? []) {
      if (f.commissionAsset === m.base) commBase += Number(f.commission);
      else if (f.commissionAsset === m.quote) commQuote += Number(f.commission);
    }
    const price = qty > 0 ? quote / qty : 0;
    return side === 'BUY'
      ? { status: r.status, price, qty, spent: quote, received: qty - commBase, orderId: r.orderId }
      : { status: r.status, price, qty, spent: qty, received: quote - commQuote, orderId: r.orderId };
  }
}

// Runs one cycle: three IOC legs in sequence, then flattens anything left in
// an intermediate asset back to home. Reports exactly what happened.
export class Executor extends EventEmitter {
  constructor({ scanner, venue, risk, cfg, mode }) {
    super();
    this.s = scanner;
    this.venue = venue;
    this.risk = risk;
    this.cfg = cfg;
    this.mode = mode;
    this.seq = 0;
  }

  // Amount flowing through each leg if every leg fills at its detection price.
  #plan(cycle, size, limits) {
    const f = 1 - this.s.feeBps / 1e4;
    const ins = [];
    let amt = size;
    cycle.legs.forEach((l, i) => {
      ins.push(amt);
      amt = l.side === 'BUY' ? (amt / limits[i]) * f : amt * limits[i] * f;
    });
    return ins;
  }

  // Parallel needs the intermediate coins already on hand; otherwise legs 2
  // and 3 would have nothing to sell until leg 1 settles.
  #canRunParallel(cycle, ins) {
    if (this.cfg.execution !== 'parallel') return false;
    return cycle.legs.every((l, i) => i === 0 || this.venue.available(l.from) >= ins[i]);
  }

  async run(opp) {
    const s = this.s;
    const cycle = s.cycles[opp.cycle];
    const size = Math.min(this.cfg.tradeSize, s.capacity[opp.cycle]);
    // Limits are the prices seen at detection; the venue must honour them or not fill.
    const limits = cycle.legs.map((l) => (l.side === 'BUY' ? s.ask[l.m] : s.bid[l.m]));
    const ins = this.#plan(cycle, size, limits);
    const parallel = this.#canRunParallel(cycle, ins);
    const ctx = this.#open(opp.cycle);
    try {
      if (parallel) {
        // All three legs leave at once: one network round trip instead of three.
        await this.#fire(ctx, cycle, [0, 1, 2], ins, limits);
      } else {
        let amt = size;
        for (let i = 0; i < 3; i++) {
          const amounts = [];
          amounts[i] = amt;
          const [r] = await this.#fire(ctx, cycle, [i], amounts, limits);
          if (!(r?.received > 0)) break;
          amt = r.received;
        }
      }
      await this.#flatten(ctx, cycle, size);
    } catch (err) {
      ctx.error = err.message;
    }
    return this.#close(ctx, opp, cycle, size, parallel ? 'parallel' : 'sequential');
  }

  // Maker strategy: one leg already filled as a resting limit order. Fire the
  // other two legs at once at the prices showing NOW (after the fill, so any
  // adverse move is paid for), then flatten whatever is left.
  async hedgeMaker({ cycle: ci, makerLeg, fill, quotedEdgeBps }) {
    const s = this.s;
    const cycle = s.cycles[ci];
    const limits = cycle.legs.map((l) => (l.side === 'BUY' ? s.ask[l.m] : s.bid[l.m]));
    limits[makerLeg] = fill.price;
    // Scale the cycle so the maker leg's input is exactly what filled.
    const unit = this.#plan(cycle, 1, limits);
    const size = fill.spent / unit[makerLeg];
    const ins = unit.map((x) => x * size);
    const ctx = this.#open(ci);
    const leg = cycle.legs[makerLeg];
    ctx.legs.push({ symbol: leg.symbol, side: leg.side, limit: fill.price, price: fill.price, qty: fill.qty, status: 'MAKER' });
    ctx.book(leg, fill);
    try {
      await this.#fire(ctx, cycle, [0, 1, 2].filter((i) => i !== makerLeg), ins, limits);
      await this.#flatten(ctx, cycle, size);
    } catch (err) {
      ctx.error = err.message;
    }
    return this.#close(ctx, { cycle: ci, edgeBps: quotedEdgeBps }, cycle, size, 'maker');
  }

  #open(cycleId) {
    const startedAt = Date.now();
    const delta = new Map(); // net change per asset caused by this trade
    this.risk.begin(cycleId, startedAt);
    return {
      startedAt, t0: process.hrtime.bigint(), delta, legs: [], error: null, sentUs: null,
      book(leg, r) {
        delta.set(leg.from, (delta.get(leg.from) ?? 0) - r.spent);
        delta.set(leg.to, (delta.get(leg.to) ?? 0) + r.received);
      },
    };
  }

  // Send IOC orders for the given legs at the same instant and book the fills.
  async #fire(ctx, cycle, idx, ins, limits) {
    const pending = idx.map((i) => this.venue.fillIoc(cycle.legs[i], ins[i], limits[i]));
    if (ctx.sentUs === null) ctx.sentUs = Number(process.hrtime.bigint() - ctx.t0) / 1000;
    const results = await Promise.allSettled(pending);
    return results.map((res, j) => {
      const i = idx[j];
      const leg = cycle.legs[i];
      if (res.status === 'rejected') { ctx.error = res.reason?.message ?? String(res.reason); return null; }
      const r = res.value;
      ctx.legs.push({ symbol: leg.symbol, side: leg.side, limit: limits[i], price: r.price, qty: r.qty, status: r.status, note: r.note });
      ctx.book(leg, r);
      return r;
    });
  }

  // Flatten: every non-home asset goes back to where it started, at market.
  // Surplus is sold; a shortfall (a leg spent inventory but its feeder leg
  // missed) is bought back, so P&L never hides inventory drift.
  async #flatten(ctx, cycle, size) {
    const s = this.s;
    const home = cycle.legs[0].from;
    for (const [asset, d] of ctx.delta) {
      if (asset === home || d === 0) continue;
      const mIdx = s.symbolIndex.get(asset + home) ?? s.symbolIndex.get(home + asset);
      if (mIdx === undefined) continue;
      const m = s.markets[mIdx];
      const mid = (s.bid[mIdx] + s.ask[mIdx]) / 2;
      const signedValue = m.base === asset ? d * mid : d / mid;
      // Lot-size rounding leaves crumbs no exchange would let you trade. Keep
      // them as inventory and mark them at mid, so P&L still counts them.
      if (Math.abs(signedValue) < Math.max(0.5, m.minNotional, size * 0.02)) {
        ctx.delta.set(home, (ctx.delta.get(home) ?? 0) + signedValue);
        ctx.delta.set(asset, 0);
        ctx.dust = (ctx.dust ?? 0) + signedValue;
        continue;
      }
      if (d > 0) {
        const u = await this.venue.unwind(asset, d, mIdx);
        ctx.legs.push({ symbol: m.symbol, side: m.base === asset ? 'SELL' : 'BUY', limit: null, price: u.price, qty: d, status: 'UNWIND' });
        ctx.delta.set(home, (ctx.delta.get(home) ?? 0) + u.received);
      } else {
        const u = await this.venue.buyBack(asset, -d, mIdx);
        ctx.legs.push({ symbol: m.symbol, side: m.base === asset ? 'BUY' : 'SELL', limit: null, price: u.price, qty: -d, status: 'UNWIND' });
        ctx.delta.set(home, (ctx.delta.get(home) ?? 0) - u.cost);
      }
      ctx.delta.set(asset, 0);
    }
  }

  #close(ctx, opp, cycle, size, execution) {
    const home = cycle.legs[0].from;
    const pnl = ctx.delta.get(home) ?? 0;
    const main = ctx.legs.filter((l) => l.status !== 'UNWIND');
    const touched = ctx.legs.some((l) => l.qty > 0);
    const unwound = ctx.legs.some((l) => l.status === 'UNWIND');
    const outcome = ctx.error ? 'error'
      : !touched ? 'missed'
      : unwound ? 'unwound'
      : main.length === 3 && main.every((l) => l.status === 'FILLED' || l.status === 'MAKER') ? 'filled'
      : 'partial';
    this.risk.end(touched ? pnl : 0);
    if (ctx.error && this.mode === 'live') this.risk.halt(`order error: ${ctx.error}`);
    this.venue.afterTrade?.();

    const trade = {
      id: `${this.mode === 'live' ? 'L' : 'P'}${ctx.startedAt.toString(36)}${(this.seq++).toString(36)}`,
      at: ctx.startedAt, mode: this.mode, cycle: opp.cycle, label: cycle.label,
      size, expectedBps: opp.edgeBps, realizedBps: touched && size > 0 ? (pnl / size) * 1e4 : 0,
      pnl: touched ? pnl : 0, outcome, legs: ctx.legs, ms: Date.now() - ctx.startedAt, error: ctx.error,
      execution, sentUs: ctx.sentUs === null ? null : Math.round(ctx.sentUs * 10) / 10,
      pFill: opp.pFill ?? null, features: opp.features ?? null,
      dust: ctx.dust ? Math.round(ctx.dust * 1e4) / 1e4 : 0,
    };
    this.emit('trade', trade);
    return trade;
  }
}
