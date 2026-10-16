import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ── Short-horizon direction predictor ───────────────────────────────────────
// Order-book microstructure is the only signal that says anything at a 10 ms
// horizon: when the best bid holds much more size than the best ask, the
// next mid change is more likely up (the ask is the side about to be eaten).
// This predictor makes a call on every BTC book update and scores itself at
// 10 ms, 100 ms and 1 s against what the mid actually did. Nothing is assumed:
// the hit rates on the dashboard are measured live.
export const HORIZONS = [10, 100, 1000];

export class MicroPredictor {
  constructor({ threshold = 0.25 } = {}) {
    this.threshold = threshold;
    this.mid = 0;
    this.micro = 0;
    this.score = 0;
    this.queues = HORIZONS.map(() => []);
    this.results = HORIZONS.map(() => []);  // ring of 1 (hit) / 0 (miss) for calls where the mid moved
    this.flat = HORIZONS.map(() => 0);      // calls where the mid did not move within the horizon
    this.calls = 0;
    this.timer = setInterval(() => this.#settle(performance.now()), 5);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  // obi: top-10-level imbalance from the depth stream, in [-1, 1].
  onBook(bid, bidQty, ask, askQty, obi = 0) {
    const now = performance.now();
    // Score pending calls against the mid that was in force until now.
    this.#settle(now);
    const mid = (bid + ask) / 2;
    const half = (ask - bid) / 2;
    const micro = bidQty + askQty > 0 ? (bid * askQty + ask * bidQty) / (bidQty + askQty) : mid;
    this.mid = mid;
    this.micro = micro;
    const l1 = half > 0 ? (micro - mid) / half : 0;
    this.score = 0.65 * l1 + 0.35 * obi;
    if (Math.abs(this.score) < this.threshold) return;
    this.calls++;
    const dir = Math.sign(this.score);
    for (const q of this.queues) {
      q.push({ t: now, mid, dir });
      if (q.length > 5000) q.shift();
    }
  }

  #settle(now) {
    if (!this.mid) return;
    HORIZONS.forEach((h, i) => {
      const q = this.queues[i];
      while (q.length && q[0].t + h <= now) {
        const c = q.shift();
        const move = Math.sign(this.mid - c.mid);
        if (move === 0) { this.flat[i]++; continue; }
        const r = this.results[i];
        r.push(move === c.dir ? 1 : 0);
        if (r.length > 3000) r.shift();
      }
    });
  }

  get stats() {
    return {
      mid: this.mid,
      micro: this.micro,
      score: Math.round(this.score * 100) / 100,
      calls: this.calls,
      horizons: HORIZONS.map((h, i) => {
        const r = this.results[i];
        const hits = r.reduce((a, b) => a + b, 0);
        const moved = r.length;
        return { ms: h, moved, hitRate: moved ? hits / moved : null, moveRate: moved + this.flat[i] ? moved / (moved + this.flat[i]) : null };
      }),
    };
  }
}

// ── Fill-probability model ──────────────────────────────────────────────────
// Online logistic regression: "will all three legs fill at the detected
// prices?" Trained on every paper or live attempt. Most losses come from
// windows that close before the orders land; this learns which ones those are.
export const FEATURES = ['edge', 'depth', 'freshest', 'stalest', 'pressure', 'spread', 'z'];

export function cycleFeatures(scanner, ci, tradeSize, now = Date.now()) {
  const s = scanner;
  let fresh = Infinity, stale = 0, pressure = 0, spread = 0;
  for (let k = ci * 3; k < ci * 3 + 3; k++) {
    const m = s.legMarket[k];
    const age = now - s.updatedAt[m];
    if (age < fresh) fresh = age;
    if (age > stale) stale = age;
    const bid = s.bid[m], ask = s.ask[m], bq = s.bidQty[m], aq = s.askQty[m];
    const mid = (bid + ask) / 2, half = (ask - bid) / 2;
    const micro = bq + aq > 0 ? (bid * aq + ask * bq) / (bq + aq) : mid;
    // Positive = the book is leaning against us (price about to move away).
    const lean = half > 0 ? (micro - mid) / half : 0;
    pressure += s.legBuy[k] ? lean : -lean;
    const sp = mid > 0 ? ((ask - bid) / mid) * 1e4 : 0;
    if (sp > spread) spread = sp;
  }
  return {
    edge: s.edge[ci] / 10,
    depth: Math.log10(Math.max(1e-6, s.capacity[ci] / tradeSize)),
    freshest: Math.log1p(Math.max(0, fresh)) / 5,
    stalest: Math.log1p(Math.max(0, stale)) / 5,
    pressure: pressure / 3,
    spread: spread / 10,
    z: Math.max(-10, Math.min(10, s.z[ci])) / 5,
  };
}

export class FillModel {
  constructor({ path, lr = 0.08, l2 = 0.001 }) {
    this.path = path;
    this.lr = lr;
    this.l2 = l2;
    this.w = new Array(FEATURES.length + 1).fill(0);
    this.n = 0;
    this.recent = [];  // { p, y } for calibration stats
    this.#load();
  }

  predict(f) {
    let z = this.w[0];
    FEATURES.forEach((k, i) => { z += this.w[i + 1] * (f[k] ?? 0); });
    return 1 / (1 + Math.exp(-z));
  }

  learn(f, filled) {
    const y = filled ? 1 : 0;
    const p = this.predict(f);
    const g = y - p;
    this.w[0] += this.lr * g;
    FEATURES.forEach((k, i) => { this.w[i + 1] += this.lr * (g * (f[k] ?? 0) - this.l2 * this.w[i + 1]); });
    this.n++;
    this.recent.push({ p, y });
    if (this.recent.length > 500) this.recent.shift();
  }

  // Replay journaled attempts so the model survives restarts.
  train(trades) {
    for (const t of trades) if (t.features && t.outcome !== 'error') this.learn(t.features, t.outcome === 'filled');
  }

  save() {
    try { writeFileSync(this.path, JSON.stringify({ w: this.w, n: this.n })); } catch { /* best effort */ }
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      const j = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(j.w) && j.w.length === this.w.length) { this.w = j.w; this.n = j.n ?? 0; }
    } catch { /* start fresh */ }
  }

  get stats() {
    const r = this.recent;
    const n = r.length;
    const brier = n ? r.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n : null;
    const fillRate = n ? r.reduce((a, x) => a + x.y, 0) / n : null;
    const acc = n ? r.filter((x) => (x.p >= 0.5) === (x.y === 1)).length / n : null;
    return {
      trained: this.n, recent: n, fillRate, brier, accuracy: acc,
      weights: Object.fromEntries([['bias', this.w[0]], ...FEATURES.map((k, i) => [k, this.w[i + 1]])].map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    };
  }
}
