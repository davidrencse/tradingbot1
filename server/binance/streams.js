import WebSocket from 'ws';

const BOOK_TAG = Buffer.from('@bookTicker"');

// bookTicker frames are the hot path (hundreds per second). Pulling the five
// fields out with indexOf is ~40% cheaper than JSON.parse on the whole frame.
// Returns null on anything unexpected so the caller falls back to JSON.parse.
export function parseBookTicker(buf) {
  const s = buf.toString('latin1');
  const i = s.indexOf('"s":"');
  if (i === -1) return null;
  const j = s.indexOf('"', i + 5);
  const num = (key) => {
    const p = s.indexOf(key, j);
    if (p === -1) return NaN;
    const start = p + key.length;
    return +s.slice(start, s.indexOf('"', start));
  };
  const out = [s.slice(i + 5, j), num('"b":"'), num('"B":"'), num('"a":"'), num('"A":"')];
  return out[1] === out[1] && out[3] === out[3] ? out : null; // NaN check
}

// A pool of combined-stream websocket connections.
//
// Streams are split across several sockets so a single slow connection never
// holds up every market, and each socket is supervised independently:
//   - exponential-backoff reconnect on close/error
//   - a watchdog that recycles a socket that goes silent
//   - proactive rotation before Binance's 24h hard disconnect
export class StreamPool {
  constructor({ wsBase, streams, perSocket = 100, staleMs = 15000, onMessage, onBook, onEvent }) {
    this.wsBase = wsBase;
    this.onMessage = onMessage;
    this.onBook = onBook;
    this.onEvent = onEvent ?? (() => {});
    this.staleMs = staleMs;
    this.sockets = [];
    // Deal streams round-robin so every socket carries some liquid markets;
    // a socket made only of quiet markets would trip the silence watchdog.
    const n = Math.max(1, Math.ceil(streams.length / perSocket));
    const buckets = Array.from({ length: n }, () => []);
    streams.forEach((st, i) => buckets[i % n].push(st));
    for (const bucket of buckets) {
      this.sockets.push({
        id: this.sockets.length,
        streams: bucket,
        ws: null,
        lastMsgAt: 0,
        openedAt: 0,
        attempts: 0,
        connected: false,
        reconnects: 0,
        timer: null,
      });
    }
    this.msgCount = 0;
    this.closed = false;
  }

  start() {
    for (const s of this.sockets) this.#connect(s);
    this.watchdog = setInterval(() => this.#watch(), 2000);
  }

  stop() {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const s of this.sockets) {
      clearTimeout(s.timer);
      s.ws?.terminate();
    }
  }

  get status() {
    return this.sockets.map((s) => ({
      id: s.id,
      streams: s.streams.length,
      connected: s.connected,
      reconnects: s.reconnects,
      silentMs: s.lastMsgAt ? Date.now() - s.lastMsgAt : null,
    }));
  }

  #connect(s) {
    if (this.closed) return;
    const url = `${this.wsBase}/stream?streams=${s.streams.join('/')}`;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10000 });
    s.ws = ws;

    ws.on('open', () => {
      s.connected = true;
      s.attempts = 0;
      s.openedAt = Date.now();
      s.lastMsgAt = Date.now();
      this.onEvent({ type: 'open', socket: s.id, streams: s.streams.length });
    });

    ws.on('message', (raw) => {
      // The clock starts at frame arrival, so reported latency includes parsing.
      const recv = process.hrtime.bigint();
      s.lastMsgAt = Date.now();
      this.msgCount++;
      if (this.onBook && raw.indexOf(BOOK_TAG) !== -1) {
        const b = parseBookTicker(raw);
        if (b) { this.onBook(b[0], b[1], b[2], b[3], b[4], recv); return; }
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.stream && msg.data) this.onMessage(msg.stream, msg.data, recv);
    });

    // ws answers server pings automatically; nothing else to do for keepalive.
    ws.on('error', (err) => this.onEvent({ type: 'error', socket: s.id, message: err.message }));
    ws.on('close', (code) => {
      const wasConnected = s.connected;
      s.connected = false;
      if (this.closed || s.ws !== ws) return;
      s.attempts++;
      s.reconnects++;
      const delay = Math.min(30000, 500 * 2 ** Math.min(s.attempts - 1, 6));
      this.onEvent({ type: 'close', socket: s.id, code, retryInMs: delay, wasConnected });
      s.timer = setTimeout(() => this.#connect(s), delay);
    });
  }

  #recycle(s, reason) {
    this.onEvent({ type: 'recycle', socket: s.id, reason });
    const old = s.ws;
    s.ws = null;
    s.connected = false;
    old?.terminate();
    s.reconnects++;
    this.#connect(s);
  }

  #watch() {
    const now = Date.now();
    for (const s of this.sockets) {
      if (!s.connected) continue;
      if (now - s.lastMsgAt > this.staleMs) this.#recycle(s, `silent for ${Math.round((now - s.lastMsgAt) / 1000)}s`);
      else if (now - s.openedAt > 23 * 3600 * 1000) this.#recycle(s, '23h rotation');
    }
  }
}
