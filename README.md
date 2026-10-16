# Dislocation

Real-time triangular-arbitrage scanner for Binance, with paper or live execution and a live dashboard.

- **115–150 markets** streamed over websocket `bookTicker`, with every book also seeded from REST at startup
- **Every triangular cycle** back to USDT is re-priced on each book change: under 10 µs from network frame to decision
- **BTC synced every second**: 1 s candles from the live book, plus a REST snapshot each second that checks for drift
- **Pattern recognition**: a per-cycle EWMA z-score dislocation detector, plus BTC order-book imbalance, a return z-score and a CUSUM regime-break detector
- **Execution**: three IOC limit legs at the prices seen at detection, sent **in parallel** by default (one network round trip instead of three); any leftover or missing coin is bought or sold back at market so P&L stays honest
- **Maker quoting** (paper): rests one leg one tick inside the spread where that locks in ≥ 3 bps after fees, then takes the other two legs the instant it fills. Fills only count when the market trades *through* the quote, and the hedge is priced after the fill, so adverse selection shows up in P&L
- **Prediction**: a microprice/order-book-pressure model forecasts BTC's next move and scores itself live at 10 ms, 100 ms and 1 s; an online logistic model learns which windows actually fill and skips the ones that won't
- **Speed**: 0.84 µs per book update (parse + re-price) on one core; run `npm run bench`
- **Risk**: kill switch, pause, cooldown, rate limit, daily loss limit, loss-streak halt, 10 s warm-up
- **24/7**: reconnect with backoff, a silence watchdog, 23 h socket rotation, a JSONL journal that survives restarts, and a supervisor script

## Run

```bash
npm install
npm start
```

Open http://127.0.0.1:8787. To keep it running around the clock:

```bash
powershell -ExecutionPolicy Bypass -File scripts/run-forever.ps1
```

Tests: `npm test`. For UI development with hot reload, run `npm run engine` and `npm run dev:web`, then open http://localhost:5173.

## What to expect

Paper mode is the default. It fills against the live order book after a simulated network delay, so an
edge that disappears before the order would land is recorded as a **miss**, not a win. On liquid markets
most cycles sit 20–40 bps *below* breakeven once three taker fees are paid. Real windows are rare, small
and short. The dashboard shows how close every cycle gets and how long each window stays open, so you
can judge that for yourself before risking anything.

Set `FEE_BPS` to your real fee tier. It matters more than any other setting.

## Live trading

Off by default. It needs `MODE=live`, an API key with spot trading only (never withdrawals), and
`LIVE_CONFIRM=I-ACCEPT-REAL-MONEY-RISK` in `.env`. Read `server/engine/executor.js` first. Live mode
risks real money, and nothing here is investment advice.
"# tradingbot1" 
