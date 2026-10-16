// Gatekeeper between "the scanner found something" and "send orders".
// Every rule here applies to paper and live alike, so paper results reflect
// what the live bot would actually have been allowed to do.
export class Risk {
  constructor(cfg) {
    this.cfg = cfg;
    this.paused = false;
    this.halted = null;          // reason string once a hard limit trips
    this.inFlight = 0;
    this.lastByCycle = new Map();
    this.recent = [];
    this.consecutiveLosses = 0;
    this.day = utcDay();
    this.dailyPnl = 0;
    // No orders until the websocket books have had time to replace the REST seed.
    this.armedAt = Date.now() + 10000;
  }

  // Returns null when a trade may proceed, otherwise the reason it may not.
  check(cycleId, now = Date.now()) {
    this.#rollDay();
    if (this.halted) return `halted: ${this.halted}`;
    if (this.paused) return 'paused';
    if (now < this.armedAt) return 'warming up';
    if (this.inFlight > 0) return 'another cycle in flight';
    const last = this.lastByCycle.get(cycleId) ?? 0;
    if (now - last < this.cfg.cooldownMs) return 'cycle cooling down';
    this.recent = this.recent.filter((t) => now - t < 60000);
    if (this.recent.length >= this.cfg.maxTradesPerMinute) return 'trade rate limit';
    return null;
  }

  begin(cycleId, now = Date.now()) {
    this.inFlight++;
    this.lastByCycle.set(cycleId, now);
    this.recent.push(now);
  }

  end(pnl) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.#rollDay();
    this.dailyPnl += pnl;
    this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;
    if (this.dailyPnl <= -this.cfg.maxDailyLoss) this.halt(`daily loss limit (${this.dailyPnl.toFixed(2)})`);
    else if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) this.halt(`${this.consecutiveLosses} losses in a row`);
  }

  halt(reason) { this.halted = reason; }
  resetHalt() { this.halted = null; this.consecutiveLosses = 0; }

  restore(trades) {
    const today = utcDay();
    for (const t of trades) if (utcDay(t.at) === today) this.dailyPnl += t.pnl;
  }

  #rollDay() {
    const d = utcDay();
    if (d !== this.day) { this.day = d; this.dailyPnl = 0; }
  }

  get state() {
    return { paused: this.paused, halted: this.halted, dailyPnl: this.dailyPnl, consecutiveLosses: this.consecutiveLosses, inFlight: this.inFlight };
  }
}

// The bot runs on the operator's machine, so "today" is their local day.
function utcDay(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
