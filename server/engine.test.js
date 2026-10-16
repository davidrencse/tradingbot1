import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from './engine/scanner.js';
import { Executor, PaperVenue, floorToStep } from './engine/executor.js';
import { Risk } from './engine/risk.js';
import { buildUniverse } from './market/universe.js';

const sym = (symbol, base, quote) => ({ symbol, baseAsset: base, quoteAsset: quote, status: 'TRADING', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001' }] });

function universe() {
  return buildUniverse({
    exchangeInfo: { symbols: [sym('BTCUSDT', 'BTC', 'USDT'), sym('ETHUSDT', 'ETH', 'USDT'), sym('ETHBTC', 'ETH', 'BTC')] },
    tickers: [
      { symbol: 'BTCUSDT', quoteVolume: '1e9', lastPrice: '100000' },
      { symbol: 'ETHUSDT', quoteVolume: '5e8', lastPrice: '4000' },
      { symbol: 'ETHBTC', quoteVolume: '1000', lastPrice: '0.04' },
    ],
    home: 'USDT', maxMarkets: 10, minMarkets: 0,
  });
}

function scanner(u, opts = {}) {
  return new Scanner({ ...u, feeBps: 0, minEdgeBps: 5, minFillable: 1, halfLifeSec: 30, dislocationZ: 4, ...opts });
}

const hr = () => process.hrtime.bigint();

test('universe finds both directions of the triangle', () => {
  const u = universe();
  assert.equal(u.markets.length, 3);
  const labels = u.cycles.map((c) => c.label).sort();
  assert.deepEqual(labels, ['USDT → BTC → ETH → USDT', 'USDT → ETH → BTC → USDT']);
});

test('prices a cycle exactly, and fees compound per leg', () => {
  const u = universe();
  const s = scanner(u);
  // Fair books: ETH/BTC = 4000/100000 = 0.04, no spread.
  s.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  s.onBook('ETHBTC', 0.04, 10, 0.04, 10, hr());
  for (const c of u.cycles) assert.ok(Math.abs(s.edge[c.id]) < 1e-6);

  const f = scanner(u, { feeBps: 10 });
  f.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  f.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  f.onBook('ETHBTC', 0.04, 10, 0.04, 10, hr());
  const expected = ((1 - 0.001) ** 3 - 1) * 1e4;
  for (const c of u.cycles) assert.ok(Math.abs(f.edge[c.id] - expected) < 1e-6);
});

test('a mispriced cross rate opens exactly one window, in the right direction', () => {
  const u = universe();
  const s = scanner(u);
  const seen = [];
  s.on('opportunity', (o) => seen.push(u.cycles[o.cycle].label));
  s.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  // ETH is 1% cheap in BTC terms: USDT → BTC → ETH → USDT should profit ~100 bps.
  s.onBook('ETHBTC', 0.0396, 10, 0.0396, 10, hr());
  assert.deepEqual(seen, ['USDT → BTC → ETH → USDT']);
  const id = u.cycles.find((c) => c.label === 'USDT → BTC → ETH → USDT').id;
  assert.ok(s.edge[id] > 100 && s.edge[id] < 102);
});

test('capacity is limited by the thinnest leg, in home units', () => {
  const u = universe();
  const s = scanner(u);
  s.onBook('BTCUSDT', 100000, 10, 100000, 0.001, hr()); // only 100 USDT of BTC on the ask
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  s.onBook('ETHBTC', 0.0396, 10, 0.0396, 10, hr());
  const id = u.cycles.find((c) => c.label === 'USDT → BTC → ETH → USDT').id;
  assert.ok(Math.abs(s.capacity[id] - 100) < 1e-9);
});

test('paper fill books the real edge; a moved price is a miss, not a fill', async () => {
  const u = universe();
  const s = scanner(u);
  s.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  s.onBook('ETHBTC', 0.0396, 10, 0.0396, 10, hr());
  const id = u.cycles.find((c) => c.label === 'USDT → BTC → ETH → USDT').id;
  const cfg = { tradeSize: 100, cooldownMs: 0, maxTradesPerMinute: 99, maxDailyLoss: 1e9, maxConsecutiveLosses: 99 };

  const ex = new Executor({ scanner: s, venue: new PaperVenue(s, { latencyMs: 0, feeBps: 0 }), risk: new Risk(cfg), cfg, mode: 'paper' });
  const t = await ex.run({ cycle: id, edgeBps: s.edge[id] });
  assert.equal(t.outcome, 'filled');
  assert.ok(t.pnl > 0.9 && t.pnl < 1.05, `pnl ${t.pnl}`);

  // The book reprices between detection and the order landing.
  const slow = new PaperVenue(s, { latencyMs: 5, feeBps: 0 });
  const ex2 = new Executor({ scanner: s, venue: slow, risk: new Risk(cfg), cfg, mode: 'paper' });
  const run = ex2.run({ cycle: id, edgeBps: s.edge[id] });
  s.onBook('BTCUSDT', 100100, 10, 100100, 10, hr());
  const t2 = await run;
  assert.equal(t2.outcome, 'missed');
  assert.equal(t2.pnl, 0);
});

test('floorToStep never rounds up', () => {
  assert.equal(floorToStep(1.239999, 0.01).text, '1.23');
  assert.equal(floorToStep(5, 1).text, '5');
});

import { parseBookTicker } from './binance/streams.js';
import { FillModel, MicroPredictor } from './engine/predict.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('fast-path parser matches JSON.parse and rejects junk', () => {
  const raw = Buffer.from('{"stream":"ethbtc@bookTicker","data":{"u":9,"s":"ETHBTC","b":"0.03960000","B":"1.2","a":"0.03961000","A":"3.4"}}');
  assert.deepEqual(parseBookTicker(raw), ['ETHBTC', 0.0396, 1.2, 0.03961, 3.4]);
  assert.equal(parseBookTicker(Buffer.from('{"stream":"x@bookTicker","data":{}}')), null);
});

function mispriced() {
  const u = universe();
  const s = scanner(u);
  s.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  s.onBook('ETHBTC', 0.0396, 10, 0.0396, 10, hr());
  const id = u.cycles.find((c) => c.label === 'USDT → BTC → ETH → USDT').id;
  return { u, s, id };
}
const pcfg = { tradeSize: 100, cooldownMs: 0, maxTradesPerMinute: 99, maxDailyLoss: 1e9, maxConsecutiveLosses: 99, execution: 'parallel' };

test('parallel execution sends all legs in one round trip and books the same edge', async () => {
  const { s, id } = mispriced();
  const ex = new Executor({ scanner: s, venue: new PaperVenue(s, { latencyMs: 30, feeBps: 0 }), risk: new Risk(pcfg), cfg: pcfg, mode: 'paper' });
  const t0 = Date.now();
  const t = await ex.run({ cycle: id, edgeBps: s.edge[id] });
  const ms = Date.now() - t0;
  assert.equal(t.execution, 'parallel');
  assert.equal(t.outcome, 'filled');
  assert.ok(t.pnl > 0.9 && t.pnl < 1.05, `pnl ${t.pnl}`);
  assert.ok(ms < 75, `took ${ms} ms; three sequential legs would take ≥ 90`);
});

test('parallel: a missed feeder leg is bought back at market, so the loss shows in P&L', async () => {
  const { s, id } = mispriced();
  const ex = new Executor({ scanner: s, venue: new PaperVenue(s, { latencyMs: 5, feeBps: 0 }), risk: new Risk(pcfg), cfg: pcfg, mode: 'paper' });
  const run = ex.run({ cycle: id, edgeBps: s.edge[id] });
  // BTC ask jumps 1.5% (more than the 1% edge) before leg 1 lands: leg 1
  // misses, legs 2 and 3 still spend inventory, and BTC is bought back dearer.
  s.onBook('BTCUSDT', 101500, 10, 101500, 10, hr());
  const t = await run;
  assert.equal(t.outcome, 'unwound');
  assert.ok(t.legs.some((l) => l.status === 'UNWIND'));
  assert.ok(t.pnl < 0, `pnl ${t.pnl} should be a loss after buying BTC back higher`);
});

test('fill model learns that fresh, deep windows fill and stale ones do not', () => {
  const m = new FillModel({ path: join(tmpdir(), `fm-${process.pid}.json`) });
  const good = { edge: 1, depth: 1, freshest: 0.2, stalest: 0.4, pressure: -0.5, spread: 0.2, z: 0.5 };
  const bad = { edge: 1, depth: -0.5, freshest: 1.2, stalest: 1.6, pressure: 0.6, spread: 1.5, z: 0.5 };
  for (let i = 0; i < 300; i++) { m.learn(good, true); m.learn(bad, false); }
  assert.ok(m.predict(good) > 0.8 && m.predict(bad) < 0.2, `${m.predict(good)} / ${m.predict(bad)}`);
});

test('micro predictor scores itself against the real next move', async () => {
  const p = new MicroPredictor();
  // Heavy bid, thin ask → calls "up"; then the mid does go up.
  p.onBook(100, 10, 101, 1, 0);
  p.onBook(101, 5, 102, 5, 0); // the move lands well inside the 10 ms horizon
  await new Promise((r) => setTimeout(r, 40));
  p.stop();
  const h10 = p.stats.horizons[0];
  assert.ok(h10.moved >= 1);
  assert.equal(h10.hitRate, 1);
});

import { MakerQuoter } from './engine/maker.js';

function makerRig({ latencyMs = 0 } = {}) {
  const u = universe();
  const s = scanner(u);
  // BTC and ETH fairly priced against USDT, but ETH/BTC has a wide spread: room to quote inside it.
  s.onBook('BTCUSDT', 100000, 10, 100000, 10, hr());
  s.onBook('ETHUSDT', 4000, 10, 4000, 10, hr());
  s.onBook('ETHBTC', 0.0398, 10, 0.0402, 10, hr());
  s.markets.forEach((m) => { m.tick = 0.00001; });
  const cfg = { ...pcfg, minFillable: 1, makerEdgeBps: 3, makerMaxQuotes: 3, makerRequoteMs: 1000 };
  const risk = new Risk(cfg);
  risk.armedAt = 0;
  const ex = new Executor({ scanner: s, venue: new PaperVenue(s, { latencyMs: 0, feeBps: 0 }), risk, cfg, mode: 'paper' });
  const mk = new MakerQuoter({ scanner: s, executor: ex, risk, cfg, makerFeeBps: 0, latencyMs });
  return { u, s, ex, mk };
}

test('maker: quotes one tick inside the spread on the leg that makes the cycle pay', () => {
  const { mk } = makerRig();
  mk.sweep();
  const q = [...mk.quotes.values()];
  assert.equal(q.length, 1);
  assert.equal(q[0].symbol, 'ETHBTC');
  assert.equal(q[0].side, 'BUY');
  assert.ok(Math.abs(q[0].price - 0.03981) < 1e-12);
  assert.ok(q[0].edgeBps > 40 && q[0].edgeBps < 50, `edge ${q[0].edgeBps}`);
});

test('maker: buyers lifting the ask, or a quote not yet live, never count as fills', () => {
  const { mk } = makerRig({ latencyMs: 50 });
  mk.sweep();
  mk.onTrade('ETHBTC', 0.0398, 10, true);           // seller hits bids, but our quote is not live yet
  mk.onTrade('ETHBTC', 0.0402, 10, false, Date.now() + 100); // buyer lifts the ask: not our side
  assert.equal(mk.stats.fills, 0);
  assert.equal(mk.quotes.size, 1);
});

test('maker: a seller trading through the quote fills it and the hedge books the locked edge', async () => {
  const { mk, ex } = makerRig();
  mk.sweep();
  const done = new Promise((r) => ex.once('trade', r));
  mk.onTrade('ETHBTC', 0.0398, 10, true);
  const t = await done;
  assert.equal(t.execution, 'maker');
  assert.equal(t.outcome, 'filled');
  assert.ok(Math.abs(t.size - 100) < 0.1, `size ${t.size}`); // quantity rounds down to the lot step
  assert.ok(t.pnl > 0.4 && t.pnl < 0.5, `pnl ${t.pnl}`);
  assert.equal(mk.quotes.size, 0);
});

test('maker: a quote that stops paying is cancelled immediately, not left to be picked off', () => {
  const { s, mk } = makerRig();
  mk.sweep();
  assert.equal(mk.quotes.size, 1);
  s.onBook('ETHUSDT', 3980, 10, 3980, 10, hr());    // ETH drops 0.5%: the quote now loses money
  mk.sweep();
  assert.equal(mk.quotes.size, 0);
  assert.equal(mk.stats.cancelled, 1);
});
