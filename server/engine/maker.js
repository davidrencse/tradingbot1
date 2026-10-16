import { EventEmitter } from 'node:events';

// Maker strategy: instead of waiting for three books to misprice at once,
// rest a limit order on ONE leg of a cycle, one tick inside the spread, and
// only where that price makes the whole cycle profitable after fees. When it
// fills, the other two legs are taken immediately (see Executor.hedgeMaker).
//
// Paper fills are deliberately strict. A resting quote is never in the real
// book, so it only counts as filled when the market proves someone traded
// THROUGH its price:
//   - a trade prints at or beyond the quote with the aggressor on the other
//     side (a seller hitting bids at or below our bid, for a buy quote), or
//   - the opposite best price crosses the quote (the ask falls to our bid).
// Joining the queue at an existing price never counts as a fill, and every
// quote (and every re-quote) only becomes live after the simulated latency.
//
// Emits 'fill' with the quote that filled.
export class MakerQuoter extends EventEmitter {
  constructor({ scanner, executor, risk, cfg, makerFeeBps, latencyMs }) {
    super();
    this.s = scanner;
    this.executor = executor;
    this.risk = risk;
    this.cfg = cfg;
    this.makerFee = 1 - makerFeeBps / 1e4;
    this.latencyMs = latencyMs;
    this.quotes = new Map();   // market index → quote (one quote per market)
    this.lastOrderAt = new Map(); // market index → last new/replace order time
    this.prints = new Map();      // market index → trade times in the last 5 minutes
    this.seq = 0;
    this.stats = { placed: 0, replaced: 0, cancelled: 0, fills: 0 };
  }

  start() { this.timer = setInterval(() => this.sweep(), 250); }
  stop() { clearInterval(this.timer); }

  // Cycle multiplier from the two taker legs at the current top of book.
  #others(ci, li) {
    const s = this.s;
    const cycle = s.cycles[ci];
    const f = s.feeMult;
    let others = 1;
    for (let j = 0; j < 3; j++) {
      if (j === li) continue;
      const m = cycle.legs[j].m;
      if (cycle.legs[j].side === 'BUY') {
        if (!(s.ask[m] > 0)) return null;
        others *= f / s.ask[m];
      } else {
        if (!(s.bid[m] > 0)) return null;
        others *= s.bid[m] * f;
      }
    }
    return others;
  }

  // Net cycle edge if the maker leg fills at `price`.
  edgeAt(ci, li, price) {
    const others = this.#others(ci, li);
    if (others === null) return -Infinity;
    const leg = this.s.cycles[ci].legs[li];
    const out = leg.side === 'BUY' ? (others * this.makerFee) / price : others * price * this.makerFee;
    return (out - 1) * 1e4;
  }

  // The best quote this leg of this cycle can carry right now, or null.
  candidate(ci, li) {
    const s = this.s;
    const others = this.#others(ci, li);
    if (others === null) return null;
    const leg = s.cycles[ci].legs[li];
    const m = s.markets[leg.m];
    const bid = s.bid[leg.m], ask = s.ask[leg.m];
    const tick = m.tick > 0 ? m.tick : Math.max(1e-8, bid * 1e-5);
    if (!(bid > 0 && ask > bid)) return null;
    // One tick inside the spread: first in the queue, never crossing.
    const price = leg.side === 'BUY' ? bid + tick : ask - tick;
    if (leg.side === 'BUY' ? price >= ask : price <= bid) return null;
    const out = leg.side === 'BUY' ? (others * this.makerFee) / price : others * price * this.makerFee;
    const edgeBps = (out - 1) * 1e4;
    // Above ~100 bps the "edge" is almost certainly a stale or broken book.
    if (edgeBps < this.cfg.makerEdgeBps || edgeBps > 100) return null;
    return { cycle: ci, leg: li, m: leg.m, side: leg.side, price, edgeBps, tick };
  }

  // Size the quote so the whole cycle moves about tradeSize of the home asset,
  // capped by what the two taker legs can absorb at the top of book.
  #size(c) {
    const s = this.s;
    const cycle = s.cycles[c.cycle];
    const f = s.feeMult;
    let amt = 1;
    const ins = [];
    let cap = Infinity;
    cycle.legs.forEach((l, i) => {
      ins.push(amt);
      const px = i === c.leg ? c.price : l.side === 'BUY' ? s.ask[l.m] : s.bid[l.m];
      if (i !== c.leg) {
        const depth = l.side === 'BUY' ? s.askQty[l.m] * px : s.bidQty[l.m];
        cap = Math.min(cap, depth / amt);
      }
      amt = l.side === 'BUY' ? (amt / px) * f : amt * px * f;
    });
    const size = Math.min(this.cfg.tradeSize, cap * 0.8);
    if (!(size >= this.cfg.minFillable)) return 0;
    const m = s.markets[c.m];
    const raw = c.side === 'BUY' ? (ins[c.leg] * size) / c.price : ins[c.leg] * size;
    const qty = m.step > 0 ? Math.floor(raw / m.step + 1e-9) * m.step : raw;
    if (qty <= 0 || qty < m.minQty || qty * c.price < m.minNotional) return 0;
    return qty;
  }

  sweep(now = Date.now()) {
    const r = this.risk;
    const blocked = r.halted || r.paused || now < r.armedAt || r.recent.filter((t) => now - t < 60000).length >= this.cfg.maxTradesPerMinute;
    if (blocked) {
      for (const q of [...this.quotes.values()]) this.#cancel(q);
      return;
    }

    // Best candidate per market, then the best markets overall.
    const perMarket = new Map();
    const cycles = this.s.cycles;
    for (let ci = 0; ci < cycles.length; ci++) {
      for (let li = 0; li < 3; li++) {
        const c = this.candidate(ci, li);
        if (c && (!perMarket.has(c.m) || c.edgeBps > perMarket.get(c.m).edgeBps)) perMarket.set(c.m, c);
      }
    }
    // Rank by edge × how likely a fill is. A 95 bps quote on a market that
    // trades twice an hour earns less than a 10 bps quote that fills every
    // few minutes. Activity = trade prints in the last 5 minutes.
    for (const c of perMarket.values()) {
      const n = this.#activity(c.m, now);
      c.prints5m = n;
      c.score = c.edgeBps * (1 - Math.exp(-n / 6));
    }
    const chosen = [...perMarket.values()]
      .sort((a, b) => b.score - a.score || b.edgeBps - a.edgeBps)
      .slice(0, this.cfg.makerMaxQuotes);
    const keep = new Set(chosen.map((c) => c.m));

    // Cancels are free (they don't count against the order-rate limit), so a
    // quote that stopped paying is pulled at once, not left to be picked off.
    for (const q of [...this.quotes.values()]) {
      if (!keep.has(q.m) || this.edgeAt(q.cycle, q.leg, q.price) < this.cfg.makerEdgeBps) this.#cancel(q);
    }

    for (const c of chosen) {
      const q = this.quotes.get(c.m);
      if (q && q.cycle === c.cycle && q.leg === c.leg && Math.abs(q.price - c.price) < c.tick / 2) {
        q.edgeBps = c.edgeBps;
        continue;
      }
      // Every new or re-priced quote is a new order: respect the order-rate budget per market.
      if (now - (this.lastOrderAt.get(c.m) ?? 0) < this.cfg.makerRequoteMs) continue;
      const qty = this.#size(c);
      if (!qty) { if (q) this.#cancel(q); continue; }
      this.lastOrderAt.set(c.m, now);
      if (q) {
        this.#settlePartial(q);
        this.stats.replaced++;
      } else {
        this.stats.placed++;
      }
      this.quotes.set(c.m, {
        id: q?.id ?? `Q${(this.seq++).toString(36)}`, ...c, qty, filled: 0, filledQuote: 0,
        placedAt: q?.placedAt ?? now, updatedAt: now, liveAt: now + this.latencyMs,
        symbol: this.s.markets[c.m].symbol,
      });
    }
  }

  // Book ticks: the opposite side crossing our price means we were taken.
  onBook(m, now = Date.now()) {
    const q = this.quotes.get(m);
    if (!q || now < q.liveAt) return;
    const s = this.s;
    if (q.side === 'BUY' && s.ask[m] > 0 && s.ask[m] <= q.price) this.#fill(q, s.askQty[m]);
    else if (q.side === 'SELL' && s.bid[m] > 0 && s.bid[m] >= q.price) this.#fill(q, s.bidQty[m]);
  }

  #activity(m, now) {
    const t = this.prints.get(m);
    if (!t) return 0;
    while (t.length && now - t[0] > 300000) t.shift();
    return t.length;
  }

  // Trade prints: an aggressor on the other side at or through our price.
  onTrade(symbol, price, qty, buyerIsMaker, now = Date.now()) {
    const m = this.s.symbolIndex.get(symbol);
    if (m === undefined) return;
    if (!this.prints.has(m)) this.prints.set(m, []);
    const t = this.prints.get(m);
    t.push(now);
    if (t.length > 2000) t.shift();
    const q = this.quotes.get(m);
    if (!q || now < q.liveAt) return;
    if (q.side === 'BUY' && buyerIsMaker && price <= q.price) this.#fill(q, qty);
    else if (q.side === 'SELL' && !buyerIsMaker && price >= q.price) this.#fill(q, qty);
  }

  #fill(q, available) {
    const take = Math.min(q.qty - q.filled, available);
    if (!(take > 0)) return;
    q.filled += take;
    // Hedge once half the quote is done; a sliver is not worth three orders.
    if (q.filled >= q.qty * 0.5) {
      this.quotes.delete(q.m);
      this.#hedge(q);
    }
  }

  // A quote that partly filled must be hedged before it is cancelled or moved.
  #settlePartial(q) {
    if (q.filled > 0) this.#hedge(q);
  }

  #cancel(q) {
    this.quotes.delete(q.m);
    this.stats.cancelled++;
    this.#settlePartial(q);
  }

  #hedge(q) {
    this.stats.fills++;
    const fill = q.side === 'BUY'
      ? { price: q.price, qty: q.filled, spent: q.filled * q.price, received: q.filled * this.makerFee, status: 'MAKER' }
      : { price: q.price, qty: q.filled, spent: q.filled, received: q.filled * q.price * this.makerFee, status: 'MAKER' };
    q.filled = 0;
    this.emit('fill', q);
    this.executor.hedgeMaker({ cycle: q.cycle, makerLeg: q.leg, fill, quotedEdgeBps: q.edgeBps });
  }

  get snapshot() {
    const s = this.s;
    const now = Date.now();
    return [...this.quotes.values()].map((q) => ({
      id: q.id, symbol: q.symbol, side: q.side, price: q.price, qty: q.qty, cycle: q.cycle, leg: q.leg,
      edgeBps: Math.round(q.edgeBps * 100) / 100, ageMs: now - q.placedAt, prints5m: this.#activity(q.m, now),
      bid: s.bid[q.m], ask: s.ask[q.m], live: now >= q.liveAt,
    }));
  }
}
