import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, assertLiveSafety } from './config.js';
import { BinanceRest, resolveVenue } from './binance/rest.js';
import { StreamPool } from './binance/streams.js';
import { buildUniverse } from './market/universe.js';
import { Scanner } from './engine/scanner.js';
import { BtcFeed } from './engine/btc.js';
import { Risk } from './engine/risk.js';
import { Executor, PaperVenue, LiveVenue } from './engine/executor.js';
import { Journal } from './journal.js';
import { MicroPredictor, FillModel, cycleFeatures } from './engine/predict.js';
import { MakerQuoter } from './engine/maker.js';

const startedAt = Date.now();
const r2 = (x) => Math.round(x * 100) / 100;

// ── Execution log ───────────────────────────────────────────────────────────
const logBuffer = [];
let pendingLog = [];
let logSeq = 0;
let suppressed = 0;
let logWindowStart = Date.now();
let logWindowCount = 0;
let journal;

function log(kind, level, msg, data) {
  const now = Date.now();
  if (now - logWindowStart > 1000) { logWindowStart = now; logWindowCount = 0; }
  if (++logWindowCount > 40 && level === 'info') { suppressed++; return; }
  const e = { id: ++logSeq, t: now, kind, level, msg, ...(data ? { data } : {}) };
  logBuffer.push(e);
  if (logBuffer.length > 400) logBuffer.shift();
  pendingLog.push(e);
  journal?.event(e);
  const tag = { good: '\x1b[36m', warn: '\x1b[33m', bad: '\x1b[31m' }[level] ?? '\x1b[90m';
  const d = new Date(now);
  const hms = `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  console.log(`${hms} ${tag}${kind.padEnd(7)}\x1b[0m ${msg}`);
}

process.on('unhandledRejection', (err) => log('system', 'bad', `Unhandled: ${err?.message ?? err}`));

// Claim-check the dashboard port before connecting to the exchange, so a
// second copy of the engine fails fast with an explanation, not a stack trace.
async function assertPortFree(host, port) {
  const probe = createServer();
  await new Promise((resolve) => {
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nPort ${port} on ${host} is already in use — most likely another copy of the engine is running.`);
        console.error(`Stop it (or open http://${host}:${port} to use it), or start this one on another port, e.g. PORT=8788.\n`);
      } else {
        console.error(`\nCannot listen on ${host}:${port}: ${err.message}\n`);
      }
      process.exit(1);
    });
    probe.listen(port, host, () => probe.close(resolve));
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
assertLiveSafety();
await assertPortFree(config.host, config.port);
journal = new Journal(config.dataDir);

const venue = await resolveVenue(config.venue, (m) => log('system', 'warn', m));
const feeSource = config.feeBps === null ? `${venue.label} published taker fee` : 'FEE_BPS';
if (config.feeBps === null) config.feeBps = venue.takerFeeBps;
if (config.makerFeeBps === null) config.makerFeeBps = venue.makerFeeBps;
log('system', 'info', `Fees: taker ${config.feeBps} bps, maker ${config.makerFeeBps} bps per leg (${feeSource}) · strategy ${config.strategy}`);
const rest = new BinanceRest(venue, { apiKey: config.apiKey, apiSecret: config.apiSecret });
const clock = await rest.syncTime();
log('system', 'info', `${venue.label} reachable · clock offset ${clock.offsetMs} ms · REST round trip ${clock.rttMs} ms`);

const [exchangeInfo, tickers] = await Promise.all([rest.exchangeInfo(), rest.tickers24h()]);
const { markets, cycles } = buildUniverse({
  exchangeInfo, tickers, home: config.homeAsset, maxMarkets: config.maxMarkets, minMarkets: config.minMarkets,
});
if (!cycles.length) throw new Error(`No triangular cycles close back to ${config.homeAsset} on ${venue.label}.`);
log('system', 'info', `Scanning ${markets.length} markets · ${cycles.length} triangular cycles back to ${config.homeAsset}`);

const scanner = new Scanner({
  markets, cycles, feeBps: config.feeBps, minEdgeBps: config.minEdgeBps, minFillable: config.minFillable,
  halfLifeSec: config.ewmaHalfLifeSec, dislocationZ: config.dislocationZ,
});

// Quiet markets only stream on change, so seed every book from REST once.
for (const t of await rest.allBookTickers()) {
  if (scanner.symbolIndex.has(t.symbol)) scanner.onBook(t.symbol, +t.bidPrice, +t.bidQty, +t.askPrice, +t.askQty, process.hrtime.bigint());
}
scanner.latN = 0;

const btcSymbol = ['BTC' + config.homeAsset, 'BTCUSDT', 'BTCUSD'].find((s) => scanner.symbolIndex.has(s));
const btc = new BtcFeed({ symbol: btcSymbol, rest, scanner, home: config.homeAsset });
await btc.seed();

const risk = new Risk(config);
const pastTrades = journal.loadTrades();
risk.restore(pastTrades);

let venueImpl;
if (config.mode === 'live') {
  const acct = await rest.account();
  const bal = acct.balances.find((b) => b.asset === config.homeAsset);
  const free = Number(bal?.free ?? 0);
  log('risk', free >= config.tradeSize ? 'info' : 'warn', `LIVE · free ${config.homeAsset} ${free} · trade size ${config.tradeSize}`);
  if (free < config.tradeSize) risk.halt(`free ${config.homeAsset} below trade size`);
  venueImpl = new LiveVenue(scanner, rest);
  await venueImpl.refreshBalances();
  setInterval(() => venueImpl.refreshBalances().catch(() => {}), 30000);
} else {
  venueImpl = new PaperVenue(scanner, { latencyMs: config.simLatencyMs, feeBps: config.feeBps });
}
const executor = new Executor({ scanner, venue: venueImpl, risk, cfg: config, mode: config.mode });

const predictor = new MicroPredictor();
const model = new FillModel({ path: join(config.dataDir, 'model.json') });
if (model.n === 0) model.train(pastTrades);
log('system', 'info', `Fill model ready · ${model.n} labelled attempts · gates entries after ${config.modelWarmup}`);
let gated = 0, explored = 0;

const maker = new MakerQuoter({
  scanner, executor, risk, cfg: config, makerFeeBps: config.makerFeeBps, latencyMs: config.simLatencyMs,
});
maker.on('fill', (q) => {
  log('exec', 'warn', `Maker fill · ${q.side.toLowerCase()} ${q.symbol} @ ${q.price} · ${cycles[q.cycle].label} · locked ${q.edgeBps.toFixed(2)} bps · hedging`, { cycle: q.cycle });
});

// ── Trading loop: detection → risk → execution ─────────────────────────────
const trades = pastTrades.slice(-500);
const totals = journal.totals();
let pendingTrades = [];
const skipNoted = new Map();

scanner.on('opportunity', (o) => {
  const c = cycles[o.cycle];
  log('detect', 'warn', `Window open · ${c.label} · ${o.edgeBps.toFixed(2)} bps net · depth ${o.capacity.toFixed(0)} ${config.homeAsset}`, { cycle: o.cycle });
  attempt(o);
});

// A window only announces itself once, when it opens. If it opened while the
// bot was warming up, busy with another cycle, or cooling down, it would never
// be tried even though it is still there. Sweep open windows and retry them.
setInterval(() => {
  if (risk.inFlight) return;
  const now = Date.now();
  for (let ci = 0; ci < cycles.length; ci++) {
    if (!scanner.openSince[ci]) continue;
    if (modelDecided.get(ci) === scanner.openSince[ci]) continue; // model already ruled on this window
    if (risk.check(ci, now)) continue;
    attempt({ cycle: ci, edgeBps: scanner.edge[ci], capacity: scanner.capacity[ci], at: now, retry: true });
    return; // one at a time; the executor is single-flight anyway
  }
}, 100);

// The fill model rules once per window (skip or explore), never once per retry.
const modelDecided = new Map();

function attempt(o) {
  if (config.strategy === 'maker') return;
  const c = cycles[o.cycle];
  let reason = risk.check(o.cycle);
  // Ask the fill model whether this window will still be there when the orders land.
  o.features = cycleFeatures(scanner, o.cycle, config.tradeSize);
  o.pFill = model.predict(o.features);
  if (!reason && model.n >= config.modelWarmup && o.pFill < config.minFillProb) {
    modelDecided.set(o.cycle, scanner.openSince[o.cycle]);
    // Paper mode still tries 1 in 10 of these so the model keeps learning
    // from the windows it rejects; live mode never does.
    if (config.mode === 'paper' && Math.random() < 0.1) {
      explored++;
    } else {
      gated++;
      reason = `fill model gives ${(o.pFill * 100).toFixed(0)}% (needs ${(config.minFillProb * 100).toFixed(0)}%)`;
    }
  }
  if (reason) {
    const last = skipNoted.get(o.cycle) ?? 0;
    if (Date.now() - last > 10000) {
      skipNoted.set(o.cycle, Date.now());
      log('risk', 'info', `Skipped ${c.label}: ${reason}`, { cycle: o.cycle });
    }
    return;
  }
  executor.run(o);
}

scanner.on('closed', (w) => {
  if (w.durationMs > 0) log('detect', 'info', `Window closed · ${cycles[w.cycle].label} · open ${w.durationMs} ms · peak ${w.peakBps.toFixed(2)} bps`, { cycle: w.cycle });
});

scanner.on('dislocation', (d) => {
  log('pattern', 'info', `Dislocation · ${cycles[d.cycle].label} · ${d.edgeBps.toFixed(2)} bps (z ${d.z.toFixed(1)})`, { cycle: d.cycle });
});

btc.on('regime', (r) => {
  log('pattern', 'warn', `BTC ${r.direction === 'up' ? 'breakout' : 'breakdown'} at ${r.price.toFixed(2)} · 60s vol ${r.volBps.toFixed(1)} bps`);
});

executor.on('trade', (t) => {
  totals.attempts++;
  if (t.outcome !== 'missed') {
    totals.fills++;
    totals.pnl += t.pnl;
    if (t.pnl > 0) totals.wins++;
  }
  trades.push(t);
  if (trades.length > 500) trades.shift();
  pendingTrades.push(t);
  journal.trade(t);
  if (t.features && t.outcome !== 'error' && t.execution !== 'maker') {
    model.learn(t.features, t.outcome === 'filled');
    if (model.n % 10 === 0) model.save();
  }
  const level = t.outcome === 'missed' ? 'info' : t.pnl > 0 ? 'good' : t.pnl < 0 ? 'bad' : 'info';
  const verb = (t.execution === 'maker' ? 'Maker cycle ' : '') + { filled: 'Filled', partial: 'Partial fill', unwound: 'Unwound', missed: 'Missed', error: 'Failed' }[t.outcome];
  const pnlText = t.outcome === 'missed' ? 'price moved before the order landed' : `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)} ${config.homeAsset} (${t.realizedBps.toFixed(2)} bps vs ${t.expectedBps.toFixed(2)} expected)`;
  const how = `${t.execution}${t.pFill != null ? ` · model ${(t.pFill * 100).toFixed(0)}%` : ''}`;
  log('exec', level, `${verb} ${t.label} · ${pnlText} · ${t.ms} ms ${how}${t.error ? ` · ${t.error}` : ''}`, { trade: t.id });
  if (risk.halted) log('risk', 'bad', `Trading halted: ${risk.halted}`);
});

// ── Market data ─────────────────────────────────────────────────────────────
const lower = btcSymbol.toLowerCase();
const streams = [
  ...markets.map((m) => `${m.symbol.toLowerCase()}@bookTicker`),
  `${lower}@depth20@100ms`,
  ...(config.strategy !== 'taker' ? markets.map((m) => `${m.symbol.toLowerCase()}@trade`) : [`${lower}@trade`]),
];

const pool = new StreamPool({
  wsBase: venue.ws,
  streams,
  onBook(symbol, b, bq, a, aq, recv) {
    scanner.onBook(symbol, b, bq, a, aq, recv);
    const mi = scanner.symbolIndex.get(symbol);
    if (mi !== undefined && maker.quotes.size) maker.onBook(mi);
    if (symbol === btcSymbol) {
      btc.onBook(b, bq, a, aq);
      predictor.onBook(b, bq, a, aq, btc.signals.obi);
    }
  },
  onMessage(stream, d, recv) {
    if (stream.endsWith('@bookTicker')) {
      const b = +d.b, bq = +d.B, a = +d.a, aq = +d.A;
      scanner.onBook(d.s, b, bq, a, aq, recv);
      if (d.s === btcSymbol) {
        btc.onBook(b, bq, a, aq);
        predictor.onBook(b, bq, a, aq, btc.signals.obi);
      }
    } else if (stream.endsWith('@depth20@100ms')) {
      btc.onDepth(d);
    } else if (stream.endsWith('@trade')) {
      if (d.s === btcSymbol) btc.onTrade(d);
      maker.onTrade(d.s, +d.p, +d.q, d.m); // also feeds per-market activity
    }
  },
  onEvent(e) {
    if (e.type === 'open') log('feed', 'info', `Socket ${e.socket} connected · ${e.streams} streams`);
    else if (e.type === 'close') log('feed', 'warn', `Socket ${e.socket} closed (${e.code}) · retry in ${e.retryInMs} ms`);
    else if (e.type === 'recycle') log('feed', 'warn', `Socket ${e.socket} recycled · ${e.reason}`);
    else if (e.type === 'error') log('feed', 'bad', `Socket ${e.socket} error · ${e.message}`);
  },
});
pool.start();
btc.start();
if (config.strategy !== 'taker') maker.start();
setInterval(() => rest.syncTime().catch(() => {}), 10 * 60 * 1000);

// ── Dashboard ───────────────────────────────────────────────────────────────
const dist = fileURLToPath(new URL('../web/dist/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.png': 'image/png' };

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), sockets: pool.status, risk: risk.state }));
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = join(dist, rel);
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    const target = s.isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(await readFile(target));
  } catch {
    try {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(await readFile(join(dist, 'index.html')));
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Dashboard not built yet. Run: npm run build');
    }
  }
});

// Only pages served from this machine may drive the control channel.
const allowedOrigin = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);
const wss = new WebSocketServer({ server: http, path: '/ws', verifyClient: ({ origin }) => allowedOrigin(origin) });
wss.on('error', () => { /* http server errors are re-emitted here; the http handler reports them */ });

function equityCurve() {
  const closed = trades.filter((t) => t.outcome !== 'missed');
  let cum = totals.pnl - closed.reduce((a, t) => a + t.pnl, 0);
  return closed.map((t) => ({ t: t.at, v: (cum += t.pnl) }));
}

function settings() {
  return {
    mode: config.mode, venue: venue.label, home: config.homeAsset, feeBps: config.feeBps,
    minEdgeBps: scanner.minEdgeBps, tradeSize: config.tradeSize, simLatencyMs: config.simLatencyMs,
    dislocationZ: config.dislocationZ, btcSymbol, maxDailyLoss: config.maxDailyLoss,
    execution: config.execution, minFillProb: config.minFillProb, modelWarmup: config.modelWarmup,
    strategy: config.strategy, makerEdgeBps: config.makerEdgeBps, makerFeeBps: config.makerFeeBps,
  };
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'hello',
    startedAt,
    settings: settings(),
    markets: markets.map((m) => ({ symbol: m.symbol, base: m.base, quote: m.quote, vol: Math.round(m.volHome) })),
    cycles: cycles.map((c) => ({ id: c.id, label: c.label, legs: c.legs.map((l) => `${l.side === 'BUY' ? 'buy' : 'sell'} ${l.symbol}`) })),
    bars1s: btc.bars1s.slice(-900),
    bars1m: btc.bars1m,
    trades: trades.slice(-200),
    equity: equityCurve(),
    log: logBuffer.slice(-200),
  }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'pause') { risk.paused = true; log('risk', 'warn', 'Execution paused from dashboard'); }
    else if (m.type === 'resume') { risk.paused = false; log('risk', 'info', 'Execution resumed from dashboard'); }
    else if (m.type === 'halt') { risk.halt('kill switch'); log('risk', 'bad', 'Kill switch engaged from dashboard'); }
    else if (m.type === 'reset-halt') { risk.resetHalt(); log('risk', 'info', 'Halt cleared from dashboard'); }
    else if (m.type === 'set') {
      if (Number.isFinite(m.minEdgeBps)) {
        const floor = config.mode === 'live' ? 1 : -50;
        scanner.minEdgeBps = Math.max(floor, Math.min(200, m.minEdgeBps));
        log('risk', 'info', `Entry threshold set to ${scanner.minEdgeBps} bps`);
      }
      if (Number.isFinite(m.tradeSize) && config.mode === 'paper') {
        config.tradeSize = Math.max(1, Math.min(1e6, m.tradeSize));
        log('risk', 'info', `Paper trade size set to ${config.tradeSize} ${config.homeAsset}`);
      }
    }
  });
});

// ── Ticks to the dashboard ─────────────────────────────────────────────────
let lastMsgs = 0, lastUpdates = 0, lastEvals = 0, lastTickAt = Date.now();
let lastBar1s = 0;
const prevUpdates = new Uint32Array(markets.length);

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000 || 1;
  const c = scanner.counters;
  const feed = {
    msgsPerSec: Math.round((pool.msgCount - lastMsgs) / dt),
    updatesPerSec: Math.round((c.bookUpdates - lastUpdates) / dt),
    evalsPerSec: Math.round((c.evaluations - lastEvals) / dt),
    latency: scanner.latency(),
    sockets: pool.status,
    feedLagMs: btc.feedLagMs,
    sync: btc.sync,
    uptimeSec: Math.round((now - startedAt) / 1000),
    restWeight: rest.usedWeight,
    suppressedLogs: suppressed,
  };
  lastMsgs = pool.msgCount; lastUpdates = c.bookUpdates; lastEvals = c.evaluations; lastTickAt = now;

  const newBars = btc.bars1s.filter((b) => b.time > lastBar1s);
  if (newBars.length) lastBar1s = newBars[newBars.length - 1].time;

  const marketRows = markets.map((m, i) => {
    const rate = (scanner.updates[i] - prevUpdates[i]) / dt;
    prevUpdates[i] = scanner.updates[i];
    return [scanner.bid[i], scanner.ask[i], Math.round(rate * 10) / 10, scanner.updatedAt[i]];
  });


  const payload = JSON.stringify({
    type: 'tick',
    t: now,
    feed,
    btc: {
      bid: btc.bid, ask: btc.ask, bidQty: btc.bidQty, askQty: btc.askQty, mid: btc.mid,
      spreadBps: btc.mid ? ((btc.ask - btc.bid) / btc.mid) * 1e4 : 0,
      signals: btc.signals, ladder: btc.ladder, tape: btc.trades.slice(-14),
      bars: [...newBars, ...(btc.cur1s ? [btc.cur1s] : [])],
      bar1m: btc.bars1m[btc.bars1m.length - 1] ?? null,
      cross: btc.crossQuotes(),
    },
    edge: Array.from(scanner.edge, (e) => (Number.isNaN(e) ? null : r2(e))),
    z: Array.from(scanner.z, (z) => Math.round(z * 10) / 10),
    top: scanner.top(14).map((i) => ({
      id: i, edge: r2(scanner.edge[i]), cap: Math.round(scanner.capacity[i]), z: Math.round(scanner.z[i] * 10) / 10,
      best: r2(scanner.best[i]), openMs: scanner.openSince[i] ? now - scanner.openSince[i] : 0,
      pFill: Math.round(model.predict(cycleFeatures(scanner, i, config.tradeSize, now)) * 100) / 100,
    })),
    markets: marketRows,
    stats: {
      opportunities: c.opportunities, dislocations: c.dislocations, windows: scanner.windowStats(),
      trades: totals.fills, attempts: totals.attempts, wins: totals.wins, pnl: totals.pnl,
    },
    risk: risk.state,
    settings: settings(),
    predict: predictor.stats,
    maker: { quotes: maker.snapshot, ...maker.stats },
    model: { ...model.stats, gated, explored, active: model.n >= config.modelWarmup },
    lastSentUs: trades.length ? trades[trades.length - 1].sentUs ?? null : null,
    log: pendingLog,
    trades: pendingTrades,
  });
  pendingLog = [];
  pendingTrades = [];
  for (const client of wss.clients) if (client.readyState === 1 && client.bufferedAmount < 2e6) client.send(payload);
}, 1000 / config.uiHz);

http.on('error', (err) => {
  console.error(`\nDashboard server failed on ${config.host}:${config.port}: ${err.message}\n`);
  process.exit(1);
});
http.listen(config.port, config.host, () => {
  log('system', 'good', `Dashboard on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} · ${config.mode.toUpperCase()} mode`);
});

function shutdown() {
  log('system', 'warn', 'Shutting down');
  model.save();
  predictor.stop();
  maker.stop();
  pool.stop();
  btc.stop();
  http.close();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
