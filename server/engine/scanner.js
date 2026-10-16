import { EventEmitter } from 'node:events';

// The hot path. Holds every top-of-book in flat typed arrays and, on each book
// update, re-prices only the cycles that touch the updated market.
//
// Emits:
//   'opportunity'  a cycle's net edge crossed minEdgeBps with enough depth
//   'closed'       that window shut again (duration, peak)
//   'dislocation'  a cycle's edge jumped far outside its own recent behaviour
export class Scanner extends EventEmitter {
  constructor({ markets, cycles, feeBps, minEdgeBps, minFillable, halfLifeSec, dislocationZ }) {
    super();
    this.markets = markets;
    this.cycles = cycles;
    this.feeBps = feeBps;
    this.minEdgeBps = minEdgeBps;
    this.minFillable = minFillable;
    this.halfLifeMs = halfLifeSec * 1000;
    this.dislocationZ = dislocationZ;

    const nm = markets.length;
    this.bid = new Float64Array(nm);
    this.ask = new Float64Array(nm);
    this.bidQty = new Float64Array(nm);
    this.askQty = new Float64Array(nm);
    this.updatedAt = new Float64Array(nm);
    this.updates = new Uint32Array(nm);
    this.symbolIndex = new Map(markets.map((m) => [m.symbol, m.idx]));

    const nc = cycles.length;
    this.legMarket = new Int32Array(nc * 3);
    this.legBuy = new Uint8Array(nc * 3);
    this.marketCycles = Array.from({ length: nm }, () => []);
    cycles.forEach((c, ci) => {
      c.legs.forEach((l, li) => {
        this.legMarket[ci * 3 + li] = l.m;
        this.legBuy[ci * 3 + li] = l.side === 'BUY' ? 1 : 0;
        if (!this.marketCycles[l.m].includes(ci)) this.marketCycles[l.m].push(ci);
      });
    });
    this.marketCycles = this.marketCycles.map((a) => Int32Array.from(a));

    this.edge = new Float64Array(nc).fill(NaN);     // net bps after fees
    this.capacity = new Float64Array(nc);           // max home-asset size at top of book
    this.mean = new Float64Array(nc).fill(NaN);     // EWMA of edge
    this.var = new Float64Array(nc);                // EWMA variance of edge
    this.z = new Float64Array(nc);
    this.lastEval = new Float64Array(nc);
    this.openSince = new Float64Array(nc);          // 0 when no window is open
    this.peak = new Float64Array(nc);
    this.lastDislocation = new Float64Array(nc);
    this.best = new Float64Array(nc).fill(-Infinity);
    this.evals = new Uint32Array(nc);

    this.lat = new Float64Array(4096);              // detection latency samples, µs
    this.latN = 0;
    this.windows = [];                              // recently closed windows
    this.counters = { evaluations: 0, opportunities: 0, dislocations: 0, bookUpdates: 0 };
  }

  get feeMult() { return 1 - this.feeBps / 1e4; }

  // Price one cycle at the current books. Returns the final amount of the home
  // asset per 1 unit put in (after fees), and writes capacity as a side effect.
  priceCycle(ci, bid = this.bid, ask = this.ask, bidQty = this.bidQty, askQty = this.askQty) {
    const f = this.feeMult;
    let amt = 1;
    let cap = Infinity;
    for (let k = ci * 3, end = k + 3; k < end; k++) {
      const m = this.legMarket[k];
      if (this.legBuy[k]) {
        const p = ask[m];
        if (!(p > 0)) return NaN;
        const c = (askQty[m] * p) / amt;
        if (c < cap) cap = c;
        amt = (amt / p) * f;
      } else {
        const p = bid[m];
        if (!(p > 0)) return NaN;
        const c = bidQty[m] / amt;
        if (c < cap) cap = c;
        amt = amt * p * f;
      }
    }
    this.capacity[ci] = cap;
    return amt;
  }

  onBook(symbol, b, bq, a, aq, recvHr) {
    const m = this.symbolIndex.get(symbol);
    if (m === undefined) return;
    this.bid[m] = b;
    this.bidQty[m] = bq;
    this.ask[m] = a;
    this.askQty[m] = aq;
    const now = Date.now();
    this.updatedAt[m] = now;
    this.updates[m]++;
    this.counters.bookUpdates++;

    const list = this.marketCycles[m];
    for (let i = 0; i < list.length; i++) this.#evaluate(list[i], now);

    const us = Number(process.hrtime.bigint() - recvHr) / 1000;
    this.lat[this.latN++ & 4095] = us;
  }

  #evaluate(ci, now) {
    this.counters.evaluations++;
    const out = this.priceCycle(ci);
    if (!(out > 0)) return;
    const e = (out - 1) * 1e4;
    this.edge[ci] = e;
    if (e > this.best[ci]) this.best[ci] = e;

    // Time-decayed EWMA of the edge: the cycle's own idea of "normal".
    const prev = this.mean[ci];
    if (Number.isNaN(prev)) {
      this.mean[ci] = e;
      this.var[ci] = 1;
    } else {
      const dt = Math.max(1, now - this.lastEval[ci]);
      const alpha = 1 - Math.exp((-dt * Math.LN2) / this.halfLifeMs);
      const d = e - prev;
      this.mean[ci] = prev + alpha * d;
      this.var[ci] = (1 - alpha) * (this.var[ci] + alpha * d * d);
    }
    this.lastEval[ci] = now;
    const sd = Math.max(0.5, Math.sqrt(this.var[ci]));
    const z = (e - this.mean[ci]) / sd;
    this.z[ci] = z;

    // A dislocation is a statistically abnormal jump that brings a cycle within
    // reach of the entry line (no more than half the entry gap below
    // breakeven). Jumps from -30 to -27 bps are noise, not opportunities.
    // Cycles need a warm-up before their baseline means anything.
    const n = ++this.evals[ci];
    const reach = -Math.max(2, this.minEdgeBps / 2);
    if (n > 200 && e >= reach && z >= this.dislocationZ && now - this.lastDislocation[ci] > 5000) {
      this.lastDislocation[ci] = now;
      this.counters.dislocations++;
      this.emit('dislocation', { cycle: ci, edgeBps: e, z, at: now });
    }

    const actionable = e >= this.minEdgeBps && this.capacity[ci] >= this.minFillable;
    if (actionable) {
      if (!this.openSince[ci]) {
        this.openSince[ci] = now;
        this.peak[ci] = e;
        this.counters.opportunities++;
        this.emit('opportunity', { cycle: ci, edgeBps: e, capacity: this.capacity[ci], at: now });
      } else if (e > this.peak[ci]) {
        this.peak[ci] = e;
      }
    } else if (this.openSince[ci]) {
      const w = { cycle: ci, openedAt: this.openSince[ci], durationMs: now - this.openSince[ci], peakBps: this.peak[ci] };
      this.openSince[ci] = 0;
      this.windows.push(w);
      if (this.windows.length > 500) this.windows.shift();
      this.emit('closed', w);
    }
  }

  latency() {
    const n = Math.min(this.latN, 4096);
    if (!n) return { p50: 0, p99: 0, max: 0, samples: 0 };
    const s = Array.from(this.lat.subarray(0, n)).sort((a, b) => a - b);
    return { p50: s[Math.floor(n * 0.5)], p99: s[Math.floor(n * 0.99)], max: s[n - 1], samples: this.latN };
  }

  windowStats() {
    const w = this.windows;
    if (!w.length) return { count: 0, medianMs: 0, p90Ms: 0, medianPeakBps: 0 };
    const d = w.map((x) => x.durationMs).sort((a, b) => a - b);
    const p = w.map((x) => x.peakBps).sort((a, b) => a - b);
    return {
      count: w.length,
      medianMs: d[Math.floor(d.length / 2)],
      p90Ms: d[Math.floor(d.length * 0.9)],
      medianPeakBps: p[Math.floor(p.length / 2)],
    };
  }

  // Cycles ranked by current net edge, best first.
  top(n) {
    const idx = [];
    for (let i = 0; i < this.cycles.length; i++) if (!Number.isNaN(this.edge[i])) idx.push(i);
    idx.sort((a, b) => this.edge[b] - this.edge[a]);
    return idx.slice(0, n);
  }
}
