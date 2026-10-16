import { EventEmitter } from 'node:events';

// BTC feed: second-by-second bars built from the live book, a REST
// cross-check every second, and a few microstructure signals that flag
// when BTC itself is moving abnormally.
//
// Emits 'regime' when the CUSUM detector sees a sustained break in returns.
export class BtcFeed extends EventEmitter {
  constructor({ symbol, rest, scanner, home }) {
    super();
    this.symbol = symbol;
    this.rest = rest;
    this.scanner = scanner;
    this.home = home;
    this.bid = 0; this.ask = 0; this.bidQty = 0; this.askQty = 0;
    this.bars1s = [];
    this.bars1m = [];
    this.cur1s = null;
    this.returns = [];          // 1s log returns, bps
    this.ladder = { bids: [], asks: [] };
    this.trades = [];
    this.feedLagMs = null;
    this.cusumUp = 0;
    this.cusumDown = 0;
    this.signals = { obi: 0, retZ: 0, volBps: 0, regime: 'calm', cusumUp: 0, cusumDown: 0, ready: false };
    this.sync = { ok: 0, failed: 0, driftBps: 0, lastAt: 0, restMid: 0 };
  }

  get mid() { return this.bid && this.ask ? (this.bid + this.ask) / 2 : 0; }

  async seed() {
    try {
      const k = await this.rest.klines(this.symbol, '1m', 360);
      this.bars1m = k.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
    } catch { /* chart simply starts empty */ }
  }

  start() {
    this.timer = setInterval(() => this.#tick(), 1000);
    this.syncTimer = setInterval(() => this.#restSync(), 1000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.syncTimer); }

  onBook(b, bq, a, aq) {
    this.bid = b; this.bidQty = bq; this.ask = a; this.askQty = aq;
    const p = (b + a) / 2;
    const t = Math.floor(Date.now() / 1000);
    if (!this.cur1s || this.cur1s.time !== t) {
      if (this.cur1s) this.#close1s(this.cur1s);
      this.cur1s = { time: t, open: p, high: p, low: p, close: p };
    } else {
      const c = this.cur1s;
      if (p > c.high) c.high = p;
      if (p < c.low) c.low = p;
      c.close = p;
    }
    const mt = t - (t % 60);
    const last = this.bars1m[this.bars1m.length - 1];
    if (!last || last.time !== mt) {
      this.bars1m.push({ time: mt, open: p, high: p, low: p, close: p });
      if (this.bars1m.length > 720) this.bars1m.shift();
    } else {
      if (p > last.high) last.high = p;
      if (p < last.low) last.low = p;
      last.close = p;
    }
  }

  onDepth(data) {
    const bids = data.bids.slice(0, 12).map(([p, q]) => [+p, +q]);
    const asks = data.asks.slice(0, 12).map(([p, q]) => [+p, +q]);
    this.ladder = { bids, asks };
    let sb = 0, sa = 0;
    for (let i = 0; i < 10; i++) { sb += bids[i]?.[1] ?? 0; sa += asks[i]?.[1] ?? 0; }
    this.signals.obi = sb + sa > 0 ? (sb - sa) / (sb + sa) : 0;
  }

  onTrade(d) {
    this.trades.push({ t: d.T, price: +d.p, qty: +d.q, side: d.m ? 'sell' : 'buy' });
    if (this.trades.length > 60) this.trades.shift();
    this.feedLagMs = Date.now() + this.rest.timeOffsetMs - d.E;
  }

  #close1s(bar) {
    this.bars1s.push(bar);
    if (this.bars1s.length > 1800) this.bars1s.shift();
    const prev = this.bars1s[this.bars1s.length - 2];
    if (prev) {
      this.returns.push(Math.log(bar.close / prev.close) * 1e4);
      if (this.returns.length > 300) this.returns.shift();
    }
  }

  // Once a second: carry the bar forward through quiet seconds and refresh signals.
  #tick() {
    const t = Math.floor(Date.now() / 1000);
    if (this.cur1s && this.cur1s.time < t) {
      this.#close1s(this.cur1s);
      const p = this.cur1s.close;
      this.cur1s = { time: t, open: p, high: p, low: p, close: p };
    }
    const r = this.returns;
    if (r.length < 30) return;
    this.signals.ready = true;
    const window = r.slice(-120);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length) || 0.01;
    const last = r[r.length - 1];
    this.signals.retZ = (last - mean) / sd;
    this.signals.volBps = Math.sqrt(r.slice(-60).reduce((a, b) => a + b * b, 0));

    // Two-sided CUSUM on standardised returns: flags a sustained drift
    // (a regime break) rather than a single noisy print.
    const k = 0.5, h = 6;
    const x = (last - mean) / sd;
    this.cusumUp = Math.max(0, this.cusumUp + x - k);
    this.cusumDown = Math.max(0, this.cusumDown - x - k);
    this.signals.cusumUp = this.cusumUp;
    this.signals.cusumDown = this.cusumDown;
    if (this.cusumUp > h || this.cusumDown > h) {
      const dir = this.cusumUp > h ? 'up' : 'down';
      this.signals.regime = dir === 'up' ? 'breakout' : 'breakdown';
      this.emit('regime', { direction: dir, price: this.mid, volBps: this.signals.volBps });
      this.cusumUp = 0;
      this.cusumDown = 0;
      this.regimeUntil = Date.now() + 30000;
    } else if (!this.regimeUntil || Date.now() > this.regimeUntil) {
      this.signals.regime = this.signals.volBps > 25 ? 'volatile' : 'calm';
    }
  }

  // REST snapshot every second: confirms the websocket book is not stale or
  // drifting, and keeps the price alive if the socket drops.
  async #restSync() {
    try {
      const r = await this.rest.bookTicker(this.symbol);
      const restMid = (Number(r.bidPrice) + Number(r.askPrice)) / 2;
      this.sync.restMid = restMid;
      this.sync.lastAt = Date.now();
      this.sync.ok++;
      if (this.mid) this.sync.driftBps = ((this.mid - restMid) / restMid) * 1e4;
      else this.onBook(+r.bidPrice, +r.bidQty, +r.askPrice, +r.askQty);
    } catch {
      this.sync.failed++;
    }
  }

  // BTC priced through every quote currency, converted back to the home asset.
  // A gap between these is exactly the kind of price error the scanner hunts.
  crossQuotes() {
    const s = this.scanner;
    const mid = (i) => (s.bid[i] > 0 && s.ask[i] > 0 ? (s.bid[i] + s.ask[i]) / 2 : 0);
    const rate = (q) => {
      if (q === this.home) return 1;
      const a = s.symbolIndex.get(q + this.home);
      if (a !== undefined && mid(a)) return mid(a);
      const b = s.symbolIndex.get(this.home + q);
      if (b !== undefined && mid(b)) return 1 / mid(b);
      return 0;
    };
    const ref = this.mid;
    const out = [];
    for (const m of s.markets) {
      if (m.base !== 'BTC') continue;
      const p = mid(m.idx);
      const r = rate(m.quote);
      if (!p || !r) continue;
      const v = p * r;
      out.push({ symbol: m.symbol, quote: m.quote, price: p, inHome: v, devBps: ref ? ((v - ref) / ref) * 1e4 : 0 });
    }
    return out;
  }
}
