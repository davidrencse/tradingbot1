import { createHmac } from 'node:crypto';
import { VENUES } from '../config.js';

export class BinanceRest {
  constructor(venue, { apiKey = '', apiSecret = '' } = {}) {
    this.venue = venue;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.timeOffsetMs = 0;
    this.usedWeight = 0;
  }

  async request(path, { method = 'GET', params = {}, signed = false, timeoutMs = 8000 } = {}) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    const headers = {};
    if (signed) {
      if (!this.apiKey || !this.apiSecret) throw new Error('Signed request without API credentials');
      query.set('timestamp', String(Date.now() + this.timeOffsetMs));
      query.set('recvWindow', '5000');
      query.set('signature', createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex'));
    }
    if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey;

    const qs = query.toString();
    const url = `${this.venue.rest}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    const weight = res.headers.get('x-mbx-used-weight-1m');
    if (weight) this.usedWeight = Number(weight);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || (typeof body.code === 'number' && body.code < 0) || (body.code === 0 && body.msg)) {
      const err = new Error(`${method} ${path} → ${res.status} ${body.msg ?? ''}`.trim());
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async syncTime() {
    const t0 = Date.now();
    const { serverTime } = await this.request('/api/v3/time');
    const t1 = Date.now();
    this.timeOffsetMs = serverTime - Math.round((t0 + t1) / 2);
    return { offsetMs: this.timeOffsetMs, rttMs: t1 - t0 };
  }

  exchangeInfo() { return this.request('/api/v3/exchangeInfo', { timeoutMs: 20000 }); }
  tickers24h() { return this.request('/api/v3/ticker/24hr', { timeoutMs: 20000 }); }
  bookTicker(symbol) { return this.request('/api/v3/ticker/bookTicker', { params: { symbol } }); }
  allBookTickers() { return this.request('/api/v3/ticker/bookTicker', { timeoutMs: 15000 }); }
  klines(symbol, interval, limit) { return this.request('/api/v3/klines', { params: { symbol, interval, limit } }); }
  account() { return this.request('/api/v3/account', { signed: true }); }

  order(params) {
    return this.request('/api/v3/order', {
      method: 'POST',
      signed: true,
      params: { newOrderRespType: 'FULL', ...params },
    });
  }
}

// Resolve the venue. "auto" probes binance.com and falls back to Binance.US
// when the global venue answers with its geo-restriction response.
export async function resolveVenue(choice, log) {
  if (choice !== 'auto') {
    const v = VENUES[choice];
    if (!v) throw new Error(`Unknown VENUE "${choice}". Use auto, binance or binanceus.`);
    return v;
  }
  for (const v of [VENUES.binance, VENUES.binanceus]) {
    try {
      await new BinanceRest(v).request('/api/v3/ping', { timeoutMs: 5000 });
      return v;
    } catch (err) {
      log?.(err.status === 451
        ? `${v.label} is geo-restricted from this network; trying the next venue (set VENUE=binanceus to skip this check)`
        : `${v.label} unavailable (${err.message}); trying next venue`);
    }
  }
  throw new Error('No Binance venue is reachable from this network.');
}
