import { useStore } from '../store';
import { price } from '../format';

// Every streamed book as a tile; tile tint encodes update rate (one hue,
// light to dark), so dead or quiet markets are obvious at a glance.
export function Markets() {
  const { markets, tick } = useStore();
  const rows = tick?.markets ?? [];
  const now = tick?.t ?? Date.now();
  const maxRate = Math.max(1, ...rows.map((r) => r[2]));
  const live = rows.filter((r) => now - r[3] < 10000).length;

  return (
    <section className="panel span-8" aria-labelledby="mkts-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="mkts-title">{markets.length} markets streaming</h2>
          <p className="panel-note">{live} updated in the last 10 s · spread in bps under each mid</p>
        </div>
        <span className="heat-scale">Quiet<i aria-hidden />Busy</span>
      </div>
      <div className="matrix" role="list">
        {markets.map((m, i) => {
          const r = rows[i];
          const mid = r && r[0] && r[1] ? (r[0] + r[1]) / 2 : 0;
          const spread = mid ? ((r[1] - r[0]) / mid) * 1e4 : 0;
          const heat = r ? Math.sqrt(r[2] / maxRate) * 0.42 : 0;
          const stale = !r || now - r[3] > 30000;
          return (
            <div key={m.symbol} className={`mkt ${stale ? 'stale' : ''}`} role="listitem" title={`${m.base}/${m.quote} · ${r ? r[2] : 0} updates/s`}>
              <div className="heat" style={{ opacity: heat }} />
              <div className="sym">{m.base}<span>{m.quote}</span></div>
              <div className="px">{mid ? price(mid) : 'no quote'}</div>
              <div className="px muted">{mid ? `${spread.toFixed(1)} bps` : '—'}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
