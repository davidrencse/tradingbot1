// Hot-path benchmark: frame parse + cycle re-pricing, on a synthetic universe
// shaped like Binance.US (coins quoted in USDT, USD and BTC).
//   npm run bench
import { buildUniverse } from './market/universe.js';
import { Scanner } from './engine/scanner.js';
import { parseBookTicker } from './binance/streams.js';

const coins = Array.from({ length: 42 }, (_, i) => `C${i}`);
const symbols = [];
const tickers = [];
const add = (base, quote, px) => {
  symbols.push({ symbol: base + quote, baseAsset: base, quoteAsset: quote, status: 'TRADING', filters: [] });
  tickers.push({ symbol: base + quote, quoteVolume: '1000000', lastPrice: String(px) });
};
add('BTC', 'USDT', 80000); add('BTC', 'USD', 80000); add('USDT', 'USD', 1); add('ETH', 'USDT', 2400); add('ETH', 'BTC', 0.03);
for (const c of coins) { add(c, 'USDT', 10); add(c, 'USD', 10); if (Number(c.slice(1)) % 3 === 0) add(c, 'BTC', 0.000125); }

const u = buildUniverse({ exchangeInfo: { symbols }, tickers, home: 'USDT', maxMarkets: 500, minMarkets: 0 });
const s = new Scanner({ ...u, feeBps: 10, minEdgeBps: 5, minFillable: 10, halfLifeSec: 30, dislocationZ: 4 });
const price = new Map(tickers.map((t) => [t.symbol, Number(t.lastPrice)]));

const frames = u.markets.map((m) => {
  const p = price.get(m.symbol);
  return Buffer.from(`{"stream":"${m.symbol.toLowerCase()}@bookTicker","data":{"u":1,"s":"${m.symbol}","b":"${(p * 0.9999).toFixed(8)}","B":"1.50000000","a":"${(p * 1.0001).toFixed(8)}","A":"2.00000000"}}`);
});

const N = 400000;
const run = (label, fn) => {
  for (let i = 0; i < 50000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn(i);
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`${label.padEnd(34)} ${(ns / 1000).toFixed(2).padStart(6)} µs/update   ${Math.round(1e9 / ns).toLocaleString()} updates/s per core`);
};

console.log(`${u.markets.length} markets · ${u.cycles.length} cycles · avg ${(u.cycles.length * 3 / u.markets.length).toFixed(1)} cycles per market\n`);
run('JSON.parse frame', (i) => { const d = JSON.parse(frames[i % frames.length]).data; return +d.b + +d.a; });
run('fast-path parse frame', (i) => parseBookTicker(frames[i % frames.length]));
run('re-price affected cycles', (i) => { const m = u.markets[i % u.markets.length]; const p = price.get(m.symbol); s.onBook(m.symbol, p * 0.9999, 1.5, p * 1.0001, 2, process.hrtime.bigint()); });
run('full hot path (parse + re-price)', (i) => { const b = parseBookTicker(frames[i % frames.length]); s.onBook(b[0], b[1], b[2], b[3], b[4], process.hrtime.bigint()); });
