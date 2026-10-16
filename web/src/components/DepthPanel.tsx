import { useStore } from '../store';
import { bps, price } from '../format';

export function DepthPanel() {
  const { tick, settings } = useStore();
  const b = tick?.btc;
  const asks = (b?.ladder.asks ?? []).slice(0, 8).reverse();
  const bids = (b?.ladder.bids ?? []).slice(0, 8);
  const maxQ = Math.max(1e-9, ...asks.map((l) => l[1]), ...bids.map((l) => l[1]));
  const obi = b?.signals.obi ?? 0;
  const home = settings?.home ?? 'USDT';

  return (
    <section className="panel span-4" aria-labelledby="depth-title">
      <div className="panel-head">
        <h2 className="panel-title" id="depth-title">BTC order book</h2>
        <p className="panel-note">Top levels, 100 ms</p>
      </div>
      <div className="ladder" role="table" aria-label="BTC order book">
        {asks.map(([p, q]) => (
          <div className="lv ask" role="row" key={`a${p}`}>
            <i style={{ width: `${(q / maxQ) * 100}%` }} />
            <span role="cell">{price(p, 2)}</span><span role="cell">{q.toFixed(5)}</span>
          </div>
        ))}
        <div className="mid"><span>Spread {b ? `${b.spreadBps.toFixed(2)} bps` : '—'}</span><span>{b ? price(b.mid, 2) : '—'}</span></div>
        {bids.map(([p, q]) => (
          <div className="lv bid" role="row" key={`b${p}`}>
            <i style={{ width: `${(q / maxQ) * 100}%` }} />
            <span role="cell">{price(p, 2)}</span><span role="cell">{q.toFixed(5)}</span>
          </div>
        ))}
        {!asks.length && <p className="empty">Waiting for depth…</p>}
      </div>

      <div className="obi">
        <div className="obi-labels"><span>Bid weight {((obi + 1) * 50).toFixed(0)}%</span><span>Ask weight {((1 - obi) * 50).toFixed(0)}%</span></div>
        <div className="obi-track" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round(obi * 100)} aria-label="Order book imbalance">
          <i style={{ width: `${(obi + 1) * 50}%` }} /><b />
        </div>
      </div>

      <h3 className="subhead">BTC across quote currencies</h3>
      <table className="grid">
        <thead><tr><th scope="col">Market</th><th scope="col" className="r">Price in {home}</th><th scope="col" className="r">vs ref, bps</th></tr></thead>
        <tbody>
          {(b?.cross ?? []).map((c) => (
            <tr key={c.symbol}>
              <td>BTC/{c.quote}</td>
              <td className="r">{price(c.inHome, 2)}</td>
              <td className={`r ${Math.abs(c.devBps) > 15 ? 'hot' : ''}`}>{bps(c.devBps, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
