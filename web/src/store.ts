import { useSyncExternalStore } from 'react';

export type Bar = { time: number; open: number; high: number; low: number; close: number };
export type LogEntry = { id: number; t: number; kind: string; level: 'info' | 'good' | 'warn' | 'bad'; msg: string; data?: { cycle?: number; trade?: string } };
export type Leg = { symbol: string; side: 'BUY' | 'SELL'; limit: number | null; price: number; qty: number; status: string; note?: string };
export type Trade = {
  id: string; at: number; mode: string; cycle: number; label: string; size: number;
  expectedBps: number; realizedBps: number; pnl: number; outcome: 'filled' | 'partial' | 'unwound' | 'missed' | 'error';
  legs: Leg[]; ms: number; error: string | null;
  execution?: 'parallel' | 'sequential' | 'maker'; sentUs?: number | null; pFill?: number | null; dust?: number;
};
export type Settings = {
  mode: 'paper' | 'live'; venue: string; home: string; feeBps: number; minEdgeBps: number; tradeSize: number;
  simLatencyMs: number; dislocationZ: number; btcSymbol: string; maxDailyLoss: number;
  execution: 'parallel' | 'sequential'; minFillProb: number; modelWarmup: number;
  strategy: 'taker' | 'maker' | 'both'; makerEdgeBps: number; makerFeeBps: number;
};
export type Market = { symbol: string; base: string; quote: string; vol: number };
export type Cycle = { id: number; label: string; legs: string[] };
export type Top = { id: number; edge: number; cap: number; z: number; best: number; openMs: number; pFill: number };
export type Signals = { obi: number; retZ: number; volBps: number; regime: 'calm' | 'volatile' | 'breakout' | 'breakdown'; cusumUp: number; cusumDown: number; ready: boolean };
export type Cross = { symbol: string; quote: string; price: number; inHome: number; devBps: number };
export type Feed = {
  msgsPerSec: number; updatesPerSec: number; evalsPerSec: number;
  latency: { p50: number; p99: number; max: number; samples: number };
  sockets: { id: number; streams: number; connected: boolean; reconnects: number; silentMs: number | null }[];
  feedLagMs: number | null; sync: { ok: number; failed: number; driftBps: number; lastAt: number; restMid: number };
  uptimeSec: number; restWeight: number; suppressedLogs: number;
};
export type Tick = {
  t: number; feed: Feed;
  btc: {
    bid: number; ask: number; bidQty: number; askQty: number; mid: number; spreadBps: number; signals: Signals;
    ladder: { bids: [number, number][]; asks: [number, number][] };
    tape: { t: number; price: number; qty: number; side: 'buy' | 'sell' }[];
    bars: Bar[]; bar1m: Bar | null; cross: Cross[];
  };
  edge: (number | null)[]; z: number[]; top: Top[];
  markets: [number, number, number, number][];
  stats: { opportunities: number; dislocations: number; windows: { count: number; medianMs: number; p90Ms: number; medianPeakBps: number }; trades: number; attempts: number; wins: number; pnl: number };
  risk: { paused: boolean; halted: string | null; dailyPnl: number; consecutiveLosses: number; inFlight: number };
  settings: Settings;
  predict: {
    mid: number; micro: number; score: number; calls: number;
    horizons: { ms: number; moved: number; hitRate: number | null; moveRate: number | null }[];
  };
  model: {
    trained: number; recent: number; fillRate: number | null; brier: number | null; accuracy: number | null;
    weights: Record<string, number>; gated: number; explored: number; active: boolean;
  };
  lastSentUs: number | null;
  maker: {
    quotes: { id: string; symbol: string; side: 'BUY' | 'SELL'; price: number; qty: number; cycle: number; leg: number; edgeBps: number; ageMs: number; bid: number; ask: number; live: boolean; prints5m: number }[];
    placed: number; replaced: number; cancelled: number; fills: number;
  };
};

export type State = {
  connection: 'connecting' | 'open' | 'closed';
  settings: Settings | null;
  markets: Market[];
  cycles: Cycle[];
  bars1s: Bar[];
  bars1m: Bar[];
  trades: Trade[];
  equity: { t: number; v: number }[];
  log: LogEntry[];
  tick: Tick | null;
  // Per-cycle peak edge since the dashboard opened; drives the seismograph afterglow.
  flashes: Map<number, number>;
  // Bumped on every (re)connect so charts know to reload their full history.
  resetToken: number;
};

const state: State = {
  connection: 'connecting', settings: null, markets: [], cycles: [], bars1s: [], bars1m: [], trades: [],
  equity: [], log: [], tick: null, flashes: new Map(), resetToken: 0,
};

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const store = { state, subscribe, get version() { return version; } };

export function useStore(): State {
  useSyncExternalStore(subscribe, () => version);
  return state;
}

function upsert(arr: Bar[], b: Bar, cap: number) {
  const last = arr[arr.length - 1];
  if (last && last.time === b.time) arr[arr.length - 1] = b;
  else if (!last || b.time > last.time) {
    arr.push(b);
    if (arr.length > cap) arr.shift();
  }
}

let ws: WebSocket | null = null;
let retry = 0;

export function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.connection = 'connecting';
  emit();

  ws.onopen = () => { retry = 0; state.connection = 'open'; emit(); };
  ws.onclose = () => {
    state.connection = 'closed';
    emit();
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') {
      state.settings = m.settings;
      state.markets = m.markets;
      state.cycles = m.cycles;
      state.bars1s = m.bars1s;
      state.bars1m = m.bars1m;
      state.trades = m.trades.slice().reverse();
      state.equity = m.equity;
      state.log = m.log.slice().reverse();
      state.resetToken++;
    } else if (m.type === 'tick') {
      const t = m as Tick & { log: LogEntry[]; trades: Trade[] };
      state.tick = t;
      state.settings = t.settings;
      for (const b of t.btc.bars) upsert(state.bars1s, b, 1800);
      if (t.btc.bar1m) upsert(state.bars1m, t.btc.bar1m, 720);
      if (t.log.length) state.log = [...t.log.reverse(), ...state.log].slice(0, 400);
      if (t.trades.length) {
        state.trades = [...t.trades.slice().reverse(), ...state.trades].slice(0, 500);
        let cum = state.equity.length ? state.equity[state.equity.length - 1].v : 0;
        for (const tr of t.trades) if (tr.outcome !== 'missed') state.equity = [...state.equity, { t: tr.at, v: (cum += tr.pnl) }];
      }
      const min = t.settings.minEdgeBps;
      t.edge.forEach((e, i) => { if (e !== null && e >= min) state.flashes.set(i, performance.now()); });
    }
    emit();
  };
}
