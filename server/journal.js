import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Append-only JSONL journal. Survives restarts so P&L and the execution log
// pick up where they left off when the bot runs 24/7.
export class Journal {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.tradesPath = join(dir, 'trades.jsonl');
    this.eventsPath = join(dir, 'events.jsonl');
  }

  trade(t) { appendFileSync(this.tradesPath, JSON.stringify(t) + '\n'); }
  event(e) { appendFileSync(this.eventsPath, JSON.stringify(e) + '\n'); }

  loadTrades(limit = 2000) { return tail(this.tradesPath, limit); }

  // Lifetime totals over every trade ever journaled.
  totals() {
    const t = { pnl: 0, fills: 0, wins: 0, attempts: 0 };
    for (const x of tail(this.tradesPath, Infinity)) {
      t.attempts++;
      if (x.outcome === 'missed') continue;
      t.fills++;
      t.pnl += x.pnl;
      if (x.pnl > 0) t.wins++;
    }
    return t;
  }
  loadEvents(limit = 300) { return tail(this.eventsPath, limit); }
}

function tail(path, limit) {
  if (!existsSync(path)) return [];
  const all = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  const lines = Number.isFinite(limit) ? all.slice(-limit) : all;
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip torn line */ } }
  return out;
}
