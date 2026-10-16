import { useStore } from '../store';
import { bps, price } from '../format';

export function MakerPanel() {
  const { tick, cycles, settings } = useStore();
  const m = tick?.maker;
  if (settings && settings.strategy === 'taker') return null;
  const quotes = m?.quotes ?? [];

  return (
    <section className="panel span-12" aria-labelledby="maker-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="maker-title">Resting maker quotes</h2>
          <p className="panel-note">
            One leg rests one tick inside the spread at a price that locks in at least {settings?.makerEdgeBps ?? 3} bps
            after fees ({settings?.makerFeeBps ?? 0} bps maker). It only counts as filled when the market trades through it.
          </p>
        </div>
        <p className="panel-note num">
          {m ? `${m.placed} placed · ${m.replaced} re-priced · ${m.cancelled} pulled · ${m.fills} filled` : '—'}
        </p>
      </div>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Side</th>
              <th scope="col" className="r">Our price</th>
              <th scope="col" className="r">Best bid</th>
              <th scope="col" className="r">Best ask</th>
              <th scope="col" className="r">Locks in</th>
              <th scope="col" className="r">Trades, 5 min</th>
              <th scope="col">Completes cycle</th>
              <th scope="col" className="r">Resting</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td className="path">{q.symbol}</td>
                <td className={q.side === 'BUY' ? 'up' : 'down'}>{q.side === 'BUY' ? 'Buy' : 'Sell'}</td>
                <td className="r">{price(q.price)}</td>
                <td className="r muted">{price(q.bid)}</td>
                <td className="r muted">{price(q.ask)}</td>
                <td className="r hot">{bps(q.edgeBps, 2)} bps</td>
                <td className="r">{q.prints5m}</td>
                <td className="muted">{cycles[q.cycle]?.label}</td>
                <td className="r">{q.live ? `${(q.ageMs / 1000).toFixed(1)} s` : 'arming'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!quotes.length && (
          <p className="empty">
            No cycle can be quoted profitably right now. A quote needs a spread wide enough to lock in {settings?.makerEdgeBps ?? 3} bps
            after the other two legs; the engine re-checks every 250 ms.
          </p>
        )}
      </div>
    </section>
  );
}
