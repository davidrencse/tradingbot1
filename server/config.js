import { fileURLToPath } from 'node:url';

// Runtime configuration. Everything is read from the environment (or a .env file
// in the project root) so the engine can be tuned without code changes.

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* no .env is fine */ }

const env = process.env;
const num = (key, fallback) => {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${v}"`);
  return n;
};
const str = (key, fallback) => (env[key] === undefined || env[key] === '' ? fallback : env[key]);

export const VENUES = {
  binance: {
    id: 'binance',
    label: 'Binance',
    rest: 'https://api.binance.com',
    ws: 'wss://stream.binance.com:9443',
    // Regular-tier spot fees.
    takerFeeBps: 10,
    makerFeeBps: 10,
  },
  binanceus: {
    id: 'binanceus',
    label: 'Binance.US',
    rest: 'https://api.binance.us',
    ws: 'wss://stream.binance.us:9443',
    // Flat 0% maker / 0.02% taker on all spot pairs since April 2026
    // (https://blog.binance.us/zero-fee-trading/). Some pairs are lower; 2 bps is the ceiling.
    takerFeeBps: 2,
    makerFeeBps: 0,
  },
};

const mode = str('MODE', 'paper');
const execution = str('EXECUTION', 'parallel');
const strategy = str('STRATEGY', 'both');
if (!['taker', 'maker', 'both'].includes(strategy)) throw new Error(`STRATEGY must be taker, maker or both, got "${strategy}"`);
if (execution !== 'parallel' && execution !== 'sequential') throw new Error(`EXECUTION must be "parallel" or "sequential", got "${execution}"`);
if (mode !== 'paper' && mode !== 'live') throw new Error(`MODE must be "paper" or "live", got "${mode}"`);

export const config = {
  // "auto" tries binance.com first and falls back to Binance.US when the
  // global venue refuses the connection (it is geo-restricted in some regions).
  venue: str('VENUE', 'auto'),

  // Asset every cycle starts and ends in. Profit is booked in this asset.
  homeAsset: str('HOME_ASSET', 'USDT'),

  // How many markets to stream. Markets are picked by 24h volume among those
  // that close at least one triangle back to the home asset.
  maxMarkets: num('MAX_MARKETS', 150),
  minMarkets: num('MIN_MARKETS', 50),

  // Per-leg taker fee in basis points. Left unset, the venue's published
  // taker fee is used (see VENUES). Override it if your account pays more.
  feeBps: num('FEE_BPS', null),
  makerFeeBps: num('MAKER_FEE_BPS', null),

  // taker: only trade windows where all three books misprice at once.
  // maker: rest one leg inside the spread and take the other two on fill.
  // both:  run the two side by side.
  strategy,
  // Net edge (after fees) a maker quote must lock in at the moment it fills.
  makerEdgeBps: num('MAKER_EDGE_BPS', 3),
  makerMaxQuotes: num('MAKER_MAX_QUOTES', 6),
  // Minimum gap between re-pricing the same quote (Binance counts every new order).
  makerRequoteMs: num('MAKER_REQUOTE_MS', 1000),

  // A cycle is actionable when its net edge (after all fees) clears this.
  minEdgeBps: num('MIN_EDGE_BPS', 5),

  // Notional per cycle in the home asset, and the floor below which the
  // top-of-book depth is too thin to bother.
  tradeSize: num('TRADE_SIZE', 100),
  minFillable: num('MIN_FILLABLE', 10),

  // Paper mode re-prices every leg against the live book this many ms after
  // detection, so the simulation pays for the same latency a real order would.
  simLatencyMs: num('SIM_LATENCY_MS', 40),

  // "parallel" sends all three legs at once (one network round trip) and
  // needs the intermediate coins pre-funded; "sequential" waits for each fill.
  // Live mode falls back to sequential whenever balances can't cover a leg.
  execution,

  // Fill-probability gate: skip windows the model thinks will close before
  // the orders land. It only starts gating after this many labelled trades.
  minFillProb: num('MIN_FILL_PROB', 0.35),
  modelWarmup: num('MODEL_WARMUP', 25),

  // Risk limits (apply in both modes).
  cooldownMs: num('COOLDOWN_MS', 1500),
  maxTradesPerMinute: num('MAX_TRADES_PER_MIN', 20),
  maxDailyLoss: num('MAX_DAILY_LOSS', 25),
  maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 6),

  // Pattern recognition: EWMA half-life of each cycle's edge, and the z-score
  // at which a move counts as a dislocation.
  ewmaHalfLifeSec: num('EWMA_HALF_LIFE_SEC', 30),
  dislocationZ: num('DISLOCATION_Z', 4),

  mode,
  liveConfirm: str('LIVE_CONFIRM', ''),
  apiKey: str('BINANCE_API_KEY', ''),
  apiSecret: str('BINANCE_API_SECRET', ''),

  // Dashboard server. Bound to loopback by default: the control channel can
  // pause the engine, so it must not be reachable from the network.
  host: str('HOST', '127.0.0.1'),
  port: num('PORT', 8787),
  uiHz: num('UI_HZ', 10),

  dataDir: str('DATA_DIR', fileURLToPath(new URL('../data/', import.meta.url))),
};

export const LIVE_CONFIRM_PHRASE = 'I-ACCEPT-REAL-MONEY-RISK';

export function assertLiveSafety() {
  if (config.mode !== 'live') return;
  const problems = [];
  if (!config.apiKey || !config.apiSecret) problems.push('BINANCE_API_KEY and BINANCE_API_SECRET are required');
  if (config.liveConfirm !== LIVE_CONFIRM_PHRASE) problems.push(`LIVE_CONFIRM must equal ${LIVE_CONFIRM_PHRASE}`);
  // Live maker quoting needs the private order-update stream to see fills the
  // moment they happen; until that exists, maker results are paper-only.
  if (config.strategy !== 'taker') problems.push('STRATEGY must be "taker" in live mode (maker quoting is paper-only for now)');
  if (problems.length) {
    throw new Error(`Refusing to start in live mode:\n  - ${problems.join('\n  - ')}`);
  }
}
