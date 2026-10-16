import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useStore } from '../store';
import { micros, price } from '../format';

const pct = (x: number | null | undefined, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const HORIZON_LABEL: Record<number, string> = { 10: '10 ms', 100: '100 ms', 1000: '1 second' };

// A hit-rate meter with the coin-flip line drawn at 50%, so "is this better
// than guessing?" is answered by position, not by reading the number.
function HitMeter({ rate }: { rate: number | null }) {
  return (
    <div className="hit-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rate == null ? undefined : Math.round(rate * 100)} aria-label="Hit rate">
      {rate != null && <i style={{ width: `${rate * 100}%` }} className={rate >= 0.55 ? 'good' : ''} />}
      <b aria-hidden />
    </div>
  );
}

export function Prediction() {
  const { tick, settings } = useStore();
  const p = tick?.predict;
  const m = tick?.model;
  const call = !p ? 0 : Math.abs(p.score) < 0.25 ? 0 : Math.sign(p.score);
  const fairBps = p && p.mid ? ((p.micro - p.mid) / p.mid) * 1e4 : 0;
  const CallIcon = call > 0 ? ArrowUpRight : call < 0 ? ArrowDownRight : Minus;
  const warmup = settings?.modelWarmup ?? 25;

  return (
    <section className="panel span-12" aria-labelledby="pred-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="pred-title">Short-horizon prediction</h2>
          <p className="panel-note">
            Order-book pressure forecasts BTC&rsquo;s next move, scored live against what the price actually did. 50% is a coin flip.
          </p>
        </div>
        <p className="panel-note">
          {settings?.execution === 'parallel' ? 'Parallel legs: one round trip' : 'Sequential legs: three round trips'}
          {tick?.lastSentUs != null && ` · last orders out ${micros(tick.lastSentUs)} after detection`}
        </p>
      </div>

      <div className="pred-grid">
        <div className="pred-cell">
          <span>Current call</span>
          <b className={call > 0 ? 'up' : call < 0 ? 'down' : ''}>
            <CallIcon size={20} aria-hidden />{call > 0 ? 'Up' : call < 0 ? 'Down' : 'No call'}
          </b>
          <small>
            Fair value {p?.micro ? price(p.micro, 2) : '—'} ({fairBps >= 0 ? '+' : ''}{fairBps.toFixed(2)} bps vs mid) · pressure {p ? p.score.toFixed(2) : '—'}
          </small>
        </div>

        {(p?.horizons ?? [{ ms: 10 }, { ms: 100 }, { ms: 1000 }]).map((h) => {
          const hh = h as NonNullable<typeof p>['horizons'][number];
          return (
            <div className="pred-cell" key={h.ms}>
              <span>Next {HORIZON_LABEL[h.ms]}</span>
              <b className={hh.hitRate != null && hh.hitRate >= 0.55 ? 'up' : ''}>{pct(hh.hitRate, 1)}</b>
              <HitMeter rate={hh.hitRate ?? null} />
              <small>
                {hh.moved ? `${hh.moved.toLocaleString()} scored moves · price moved after ${pct(hh.moveRate)} of calls` : 'Waiting for the price to move'}
              </small>
            </div>
          );
        })}

        <div className="pred-cell">
          <span>Fill model</span>
          <b>{m ? (m.active ? `Gating at ${pct(settings?.minFillProb)}` : `Learning ${Math.min(m.trained, warmup)}/${warmup}`) : '—'}</b>
          <small>
            {m && m.recent
              ? `Right ${pct(m.accuracy)} of the time on ${m.recent} attempts · actual fill rate ${pct(m.fillRate)} · skipped ${m.gated}, explored ${m.explored}`
              : 'Learns from every attempt whether all three legs will fill.'}
          </small>
        </div>
      </div>
    </section>
  );
}
