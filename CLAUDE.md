# Dislocation: notes for Claude Code

Binance triangular-arbitrage scanner. A deterministic Node engine (`server/`) does detection and
execution in microseconds. A React dashboard (`web/`) shows it live.

## Claude's role: strategist, not the hot path

An LLM call takes seconds and arbitrage windows close in milliseconds, so Claude never sits between
a price tick and an order. Claude owns the *trading logic* offline:

1. **Review performance** by reading `data/trades.jsonl` (one JSON trade per line) and `data/events.jsonl`
   (the execution log). Useful cuts: realized vs expected bps per cycle, `missed` rate per cycle, which
   leg expires most, window durations (`Window closed … open N ms`).
2. **Tune parameters** in `.env` (see `.env.example`): `MIN_EDGE_BPS`, `TRADE_SIZE`, `SIM_LATENCY_MS`,
   `COOLDOWN_MS`, `DISLOCATION_Z`, `FEE_BPS`. Restart the engine to apply. Entry threshold and paper
   size can also be changed live from the dashboard.
3. **Change strategy code** in `server/engine/`, then run `npm test` (and `npm run bench` for hot-path changes) before restarting.

## Map

- `server/market/universe.js`: picks markets by liquidity and enumerates home → X → Y → home cycles
- `server/engine/scanner.js`: typed-array books; re-prices only the cycles touching an updated market;
  EWMA z-score dislocation detector; window open/close tracking
- `server/engine/btc.js`: BTC 1s bars, REST cross-check every second, OBI / return z / CUSUM regime detector
- `server/engine/executor.js`: three IOC legs (parallel or sequential), then flatten any coin surplus/shortfall to home. `PaperVenue`
  fills against the live book after simulated latency; `LiveVenue` sends signed orders
- `server/engine/predict.js`: `MicroPredictor` (BTC next-move forecast, self-scored at 10 ms/100 ms/1 s) and
  `FillModel` (online logistic regression on window features; weights in `data/model.json`)
- `server/engine/maker.js`: `MakerQuoter`: one resting quote per market, strict trade-through fill rule,
  per-market order budget; fills call `Executor.hedgeMaker`. Paper-only (live refuses `STRATEGY` other than taker)
- `server/engine/risk.js`: pause, kill switch, cooldown, rate limit, daily loss, loss streak, warm-up
- `server/index.js`: wiring, 10 Hz websocket to the dashboard, control channel (localhost-origin only)

## Rules

- Never switch `MODE=live` or touch API keys on the user's behalf. Live trading is the user's decision.
- Keep paper and live on the same code path (`Executor` + venue adapter) so paper results stay honest.
- Do not loosen the paper simulator (latency, IOC limits, partial fills) to make results look better.
