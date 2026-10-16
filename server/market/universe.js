// Builds the trading universe: which markets to stream and which triangular
// cycles (home → X → Y → home) can be closed with them.

const STABLES = new Set(['USDT', 'USD', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI']);

function filterValue(sym, type, key) {
  const f = sym.filters?.find((x) => x.filterType === type);
  return f && f[key] !== undefined ? Number(f[key]) : 0;
}

// Rough value of one unit of `asset` in the home asset, from 24h last prices.
function valuator(tickers, home) {
  const last = new Map(tickers.map((t) => [t.symbol, Number(t.lastPrice)]));
  return (asset) => {
    if (asset === home) return 1;
    if (last.get(asset + home)) return last.get(asset + home);
    if (last.get(home + asset)) return 1 / last.get(home + asset);
    if (STABLES.has(asset) && STABLES.has(home)) return 1;
    for (const via of ['BTC', 'ETH', 'BNB']) {
      const a = last.get(asset + via);
      const b = last.get(via + home);
      if (a && b) return a * b;
    }
    return 0;
  };
}

export function buildUniverse({ exchangeInfo, tickers, home, maxMarkets, minMarkets }) {
  const vol = new Map(tickers.map((t) => [t.symbol, Number(t.quoteVolume)]));
  const value = valuator(tickers, home);

  const all = exchangeInfo.symbols
    .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed !== false)
    .map((s) => ({
      symbol: s.symbol,
      base: s.baseAsset,
      quote: s.quoteAsset,
      step: filterValue(s, 'LOT_SIZE', 'stepSize'),
      minQty: filterValue(s, 'LOT_SIZE', 'minQty'),
      tick: filterValue(s, 'PRICE_FILTER', 'tickSize'),
      minNotional: filterValue(s, 'NOTIONAL', 'minNotional') || filterValue(s, 'MIN_NOTIONAL', 'minNotional'),
      volHome: (vol.get(s.symbol) ?? 0) * value(s.quoteAsset),
    }));

  const adj = new Map();
  const link = (asset, m, other) => {
    if (!adj.has(asset)) adj.set(asset, []);
    adj.get(asset).push({ m, other });
  };
  for (const m of all) {
    link(m.base, m, m.quote);
    link(m.quote, m, m.base);
  }

  // A leg converts `from` into `to` through market m: buying the base when we
  // hold the quote, selling the base when we hold it.
  const leg = (m, from, to) => ({ m, from, to, side: m.quote === from ? 'BUY' : 'SELL' });

  const cycles = [];
  for (const { m: m1, other: x } of adj.get(home) ?? []) {
    for (const { m: m2, other: y } of adj.get(x) ?? []) {
      if (y === home || m2 === m1) continue;
      for (const { m: m3, other: back } of adj.get(y) ?? []) {
        if (back !== home || m3 === m2 || m3 === m1) continue;
        cycles.push({
          legs: [leg(m1, home, x), leg(m2, x, y), leg(m3, y, home)],
          score: Math.min(m1.volHome, m2.volHome, m3.volHome),
        });
      }
    }
  }
  cycles.sort((a, b) => b.score - a.score);

  // Greedily admit the most liquid cycles until the market budget is spent.
  const selected = new Set();
  for (const c of cycles) {
    const extra = c.legs.filter((l) => !selected.has(l.m));
    if (selected.size + extra.length > maxMarkets) continue;
    for (const l of extra) selected.add(l.m);
  }
  // The BTC feed is always streamed, whether or not it closes a cycle.
  for (const m of all) if (m.base === 'BTC' && STABLES.has(m.quote)) selected.add(m);

  // Top up with the most liquid remaining markets that touch the home asset
  // so the scanner always watches at least minMarkets books.
  if (selected.size < minMarkets) {
    const rest = all.filter((m) => !selected.has(m) && (m.quote === home || m.base === home))
      .sort((a, b) => b.volHome - a.volHome);
    for (const m of rest) {
      if (selected.size >= minMarkets) break;
      selected.add(m);
    }
  }

  const markets = [...selected].sort((a, b) => b.volHome - a.volHome);
  markets.forEach((m, i) => { m.idx = i; });

  const finalCycles = cycles
    .filter((c) => c.legs.every((l) => selected.has(l.m)))
    .map((c, id) => ({
      id,
      label: [c.legs[0].from, ...c.legs.map((l) => l.to)].join(' → '),
      legs: c.legs.map((l) => ({ m: l.m.idx, side: l.side, from: l.from, to: l.to, symbol: l.m.symbol })),
      score: c.score,
    }));

  return { markets, cycles: finalCycles };
}
