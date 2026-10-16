import { memo, useMemo, useState } from 'react';
import { Crosshair, Radar, Radio, ShieldAlert, Sparkles, Terminal, Zap } from 'lucide-react';
import { useStore, type LogEntry, type Trade } from '../store';
import { clock, price } from '../format';

const KINDS: Record<string, { label: string; icon: typeof Zap }> = {
  exec: { label: 'Execution', icon: Zap },
  detect: { label: 'Window', icon: Crosshair },
  pattern: { label: 'Pattern', icon: Sparkles },
  feed: { label: 'Feed', icon: Radio },
  risk: { label: 'Risk', icon: ShieldAlert },
  system: { label: 'System', icon: Terminal },
};

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'exec', label: 'Executions' },
  { id: 'detect', label: 'Windows' },
  { id: 'pattern', label: 'Patterns' },
  { id: 'risk', label: 'Risk' },
  { id: 'feed', label: 'Feed' },
] as const;

const Row = memo(function Row({ e, trade }: { e: LogEntry; trade?: Trade }) {
  const [open, setOpen] = useState(false);
  const k = KINDS[e.kind] ?? { label: e.kind, icon: Radar };
  const body = (
    <>
      <time dateTime={new Date(e.t).toISOString()}>{clock(e.t)}</time>
      <span className="kind"><k.icon size={13} aria-hidden />{k.label}</span>
      <span className="msg">{e.msg}</span>
    </>
  );
  return (
    <li>
      {trade ? (
        <button className={`log-row ${e.level}`} aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button>
      ) : (
        <div className={`log-row ${e.level}`}>{body}</div>
      )}
      {trade && open && (
        <div className="legs" role="table" aria-label="Order legs">
          <span className="h">Market</span><span className="h">Side</span><span className="h opt">Limit</span><span className="h">Fill</span><span className="h opt">Status</span>
          {trade.legs.map((l, i) => (
            <Leg key={i} l={l} />
          ))}
        </div>
      )}
    </li>
  );
});

function Leg({ l }: { l: Trade['legs'][number] }) {
  return (
    <>
      <span>{l.symbol}</span>
      <span className={l.side === 'BUY' ? 'up' : 'down'}>{l.side.toLowerCase()}</span>
      <span className="opt">{l.limit ? price(l.limit) : 'market'}</span>
      <span>{l.qty > 0 ? `${+l.qty.toPrecision(6)} @ ${price(l.price)}` : 'no fill'}</span>
      <span className="opt">{l.status.toLowerCase().replace('_', ' ')}</span>
    </>
  );
}

export function ExecutionLog() {
  const { log, trades } = useStore();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const byId = useMemo(() => new Map(trades.map((t) => [t.id, t])), [trades]);
  const rows = (filter === 'all' ? log : log.filter((e) => e.kind === filter)).slice(0, 250);

  return (
    <section className="panel span-7 log-panel" aria-labelledby="log-title">
      <div className="panel-head">
        <h2 className="panel-title" id="log-title">Execution log</h2>
        <div className="filters" role="group" aria-label="Filter log">
          {FILTERS.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>
      <div className="scroll">
        <ol className="log">
          {rows.map((e) => <Row key={e.id} e={e} trade={e.data?.trade ? byId.get(e.data.trade) : undefined} />)}
        </ol>
        {!rows.length && <p className="empty">Nothing here yet. {filter === 'exec' ? 'Executions appear when a cycle clears the entry line.' : 'Events stream in as the engine runs.'}</p>}
      </div>
    </section>
  );
}
