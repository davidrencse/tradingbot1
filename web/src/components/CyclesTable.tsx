import { useStore } from '../store';
import { bps, compact } from '../format';

function Path({ label }: { label: string }) {
  const parts = label.split(' → ');
  return (
    <span className="path">
      {parts.map((p, i) => (
        <span key={i}>{i > 0 && <span className="via"> → </span>}{p}</span>
      ))}
    </span>
  );
}

export function CyclesTable() {
  const { tick, cycles, settings } = useStore();
  const min = settings?.minEdgeBps ?? 5;
  const rows = tick?.top ?? [];
  const modelOn = !!tick?.model.active;
  const scale = Math.max(min * 2, ...rows.map((r) => Math.abs(r.edge)));

  return (
    <section className="panel span-5" aria-labelledby="cycles-title" style={{ height: 520 }}>
      <div className="panel-head">
        <h2 className="panel-title" id="cycles-title">Closest to profit</h2>
        <p className="panel-note">Ranked by net edge right now</p>
      </div>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Cycle</th>
              <th scope="col" className="r">Net bps</th>
              <th scope="col" className="r">Depth</th>
              <th scope="col" className="r">Fill odds</th>
              <th scope="col" className="r">z</th>
              <th scope="col" className="r">Best seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = r.openMs > 0;
              const w = Math.min(100, (Math.abs(r.edge) / scale) * 100);
              const color = r.edge >= min ? 'var(--amber)' : r.edge >= 0 ? 'var(--ink-2)' : 'var(--ink-3)';
              return (
                <tr key={r.id} className={open ? 'open' : ''}>
                  <td>
                    <Path label={cycles[r.id]?.label ?? `#${r.id}`} />
                    {open && <span className="tag hot" style={{ marginLeft: 8 }}>open {r.openMs} ms</span>}
                  </td>
                  <td className={`r ${r.edge >= min ? 'hot' : ''}`}>
                    {bps(r.edge, 2)}
                    <span className="edgebar" aria-hidden><i style={{ width: `${w}%`, background: color }} /></span>
                  </td>
                  <td className="r">{compact(r.cap)}</td>
                  <td className={`r ${modelOn && r.pFill < (settings?.minFillProb ?? 0) ? 'muted' : ''}`} title={modelOn ? 'Fill model estimate' : 'Model still learning'}>
                    {modelOn ? `${Math.round(r.pFill * 100)}%` : '—'}
                  </td>
                  <td className={`r ${r.z >= (settings?.dislocationZ ?? 4) ? 'hot' : ''}`}>{r.z.toFixed(1)}</td>
                  <td className="r muted">{bps(r.best, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="empty">Pricing cycles as the first books arrive…</p>}
      </div>
    </section>
  );
}
