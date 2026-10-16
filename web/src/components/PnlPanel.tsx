import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts';
import { store, useStore } from '../store';
import { micros, money, usePalette } from '../format';

const TZ = -new Date().getTimezoneOffset() * 60;

// One point per second (the chart needs strictly increasing times).
function curve(equity: { t: number; v: number }[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of equity) {
    const time = (Math.floor(p.t / 1000) + TZ) as UTCTimestamp;
    if (out.length && out[out.length - 1].time === time) out[out.length - 1].value = p.v;
    else if (!out.length || time > out[out.length - 1].time) out.push({ time, value: p.v });
  }
  return out;
}

function Equity({ empty }: { empty: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const pal = usePalette();

  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: 'transparent' }, textColor: pal.ink3, fontFamily: 'Barlow, system-ui', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: { borderVisible: false, timeVisible: true, visible: false },
      crosshair: { vertLine: { color: pal.ink3, labelVisible: false }, horzLine: { color: pal.ink3, labelBackgroundColor: pal.panel2 } },
      handleScroll: false, handleScale: false,
    });
    const s = chart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: pal.teal, bottomLineColor: pal.coral,
      topFillColor1: pal.teal + '33', topFillColor2: pal.teal + '05',
      bottomFillColor1: pal.coral + '05', bottomFillColor2: pal.coral + '33',
      lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });
    let n = -1;
    const draw = () => {
      const eq = store.state.equity;
      if (eq.length === n) return;
      n = eq.length;
      s.setData(curve(eq));
      chart.timeScale().fitContent();
    };
    draw();
    const unsub = store.subscribe(draw);
    return () => { unsub(); chart.remove(); };
  }, [pal]);

  return (
    <div className="equity-box">
      <div ref={el} className="chart" role="img" aria-label="Cumulative profit and loss" />
      {empty && <div className="chart-wait">No fills yet. Cycles that clear the threshold are attempted automatically.</div>}
    </div>
  );
}

export function PnlPanel() {
  const { tick, settings, equity } = useStore();
  const s = tick?.stats;
  const pnl = s?.pnl ?? (equity.length ? equity[equity.length - 1].v : 0);
  const home = settings?.home ?? 'USDT';
  const winRate = s && s.trades ? (s.wins / s.trades) * 100 : null;
  const missed = s ? s.attempts - s.trades : 0;
  const lat = tick?.feed.latency;

  return (
    <section className="panel span-4" aria-labelledby="pnl-title">
      <div className="panel-head">
        <h2 className="panel-title" id="pnl-title">Profit and loss</h2>
        <p className="panel-note">{settings?.mode === 'live' ? 'Real fills' : 'Paper fills against the live book'}</p>
      </div>
      <div className={`pnl-hero ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
        {money(pnl, 4)}<small>{home}</small>
      </div>
      <div className="pnl-sub">
        Today {money(tick?.risk.dailyPnl ?? 0, 4)} {home} · loss limit {settings?.maxDailyLoss ?? '—'} {home}
      </div>
      <Equity empty={!equity.length} />
      <dl className="stats">
        <div><dt>Fills</dt><dd>{s?.trades ?? 0}</dd></div>
        <div><dt>Win rate</dt><dd>{winRate === null ? '—' : `${winRate.toFixed(0)}%`}</dd></div>
        <div><dt>Missed (price moved)</dt><dd>{missed}</dd></div>
        <div><dt>Windows opened</dt><dd>{s?.opportunities ?? 0}</dd></div>
        <div><dt>Median window</dt><dd>{s?.windows.count ? `${s.windows.medianMs} ms` : '—'}</dd></div>
        <div><dt>Dislocations</dt><dd>{s?.dislocations ?? 0}</dd></div>
        <div><dt>Detect p50</dt><dd>{lat ? micros(lat.p50) : '—'}</dd></div>
        <div><dt>Detect p99</dt><dd>{lat ? micros(lat.p99) : '—'}</dd></div>
      </dl>
    </section>
  );
}
