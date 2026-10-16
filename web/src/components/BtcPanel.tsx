import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type SeriesMarker, type UTCTimestamp } from 'lightweight-charts';
import { Activity, TrendingDown, TrendingUp, Waves } from 'lucide-react';
import { store, useStore, type Bar } from '../store';
import { bps, price, usePalette } from '../format';

// lightweight-charts renders in UTC; shift so the axis reads in local time.
const TZ = -new Date().getTimezoneOffset() * 60;
const local = (b: Bar) => ({ ...b, time: (b.time + TZ) as UTCTimestamp });

type Frame = '1s' | '1m';

function BtcChart({ frame }: { frame: Frame }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lastTime = useRef(0);
  const markerCount = useRef(-1);
  const pal = usePalette();
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: 'transparent' }, textColor: pal.ink3, fontFamily: 'Barlow, system-ui', fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { color: pal.line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: frame === '1s', rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: pal.ink3, labelBackgroundColor: pal.panel2 }, horzLine: { color: pal.ink3, labelBackgroundColor: pal.panel2 } },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addCandlestickSeries({
      upColor: pal.teal, downColor: pal.coral, wickUpColor: pal.teal, wickDownColor: pal.coral, borderVisible: false,
      priceLineColor: pal.ink3, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const load = () => {
      const bars = frame === '1s' ? store.state.bars1s : store.state.bars1m;
      series.setData(bars.map(local));
      lastTime.current = bars.length ? bars[bars.length - 1].time : 0;
      markerCount.current = -1;
      setEmpty(bars.length === 0);
    };
    load();
    let token = store.state.resetToken;

    const unsub = store.subscribe(() => {
      if (store.state.resetToken !== token) { token = store.state.resetToken; load(); return; }
      const bars = frame === '1s' ? store.state.bars1s : store.state.bars1m;
      let i = bars.length - 1;
      while (i > 0 && bars[i - 1].time >= lastTime.current) i--;
      for (; i >= 0 && i < bars.length; i++) {
        if (bars[i].time >= lastTime.current) {
          series.update(local(bars[i]));
          lastTime.current = bars[i].time;
        }
      }
      if (bars.length) setEmpty(false);

      // Regime breaks found by the CUSUM detector, pinned to the bar they happened on.
      const regimes = store.state.log.filter((e) => e.kind === 'pattern' && e.msg.startsWith('BTC'));
      if (regimes.length !== markerCount.current) {
        markerCount.current = regimes.length;
        const step = frame === '1s' ? 1 : 60;
        const first = bars[0]?.time ?? Infinity;
        const markers: SeriesMarker<UTCTimestamp>[] = regimes
          .map((e) => ({ t: Math.floor(e.t / 1000 / step) * step, up: e.msg.includes('breakout') }))
          .filter((m) => m.t >= first)
          .sort((a, b) => a.t - b.t)
          .map((m) => ({
            time: (m.t + TZ) as UTCTimestamp,
            position: m.up ? 'belowBar' : 'aboveBar',
            color: pal.amber,
            shape: m.up ? 'arrowUp' : 'arrowDown',
            text: m.up ? 'Breakout' : 'Breakdown',
          }));
        series.setMarkers(markers);
      }
    });
    return () => { unsub(); chart.remove(); };
  }, [frame, pal]);

  return (
    <div className="chart-box">
      <div ref={el} className="chart" role="img" aria-label={`${frame} BTC price candles`} />
      {empty && <div className="chart-wait">Waiting for the first BTC prints…</div>}
    </div>
  );
}

const REGIME = {
  calm: { label: 'Calm', icon: Waves, cls: '' },
  volatile: { label: 'Volatile', icon: Activity, cls: 'hot' },
  breakout: { label: 'Breakout', icon: TrendingUp, cls: 'hot' },
  breakdown: { label: 'Breakdown', icon: TrendingDown, cls: 'hot' },
};

export function BtcPanel() {
  const { tick, settings } = useStore();
  const [frame, setFrame] = useState<Frame>('1s');
  const b = tick?.btc;
  // Colour follows the move against the last completed second, not every tick.
  const closed = store.state.bars1s[store.state.bars1s.length - 2];
  const dir = b && closed ? Math.sign(b.mid - closed.close) : 0;
  const ready = !!b?.signals.ready;
  const warm = 'warming up';
  const sig = b?.signals;
  const regime = REGIME[sig?.regime ?? 'calm'];
  const sync = tick?.feed.sync;
  const syncFresh = sync && Date.now() - sync.lastAt < 3000;

  return (
    <section className="panel span-8" aria-labelledby="btc-title" style={{ minHeight: 520 }}>
      <div className="quote-row">
        <div className="quote-main">
          <span className="pair" id="btc-title">{settings?.btcSymbol ?? 'BTC'} · live mid</span>
          <span className={`px ${dir > 0 ? 'up' : dir < 0 ? 'down' : ''}`} aria-live="off">{b ? price(b.mid, 2) : '—'}</span>
        </div>
        <dl className="quote-side">
          <dt>Bid</dt><dd>{b ? price(b.bid, 2) : '—'}</dd>
          <dt>Ask</dt><dd>{b ? price(b.ask, 2) : '—'}</dd>
        </dl>
        <dl className="quote-side">
          <dt>Spread</dt><dd>{b ? `${b.spreadBps.toFixed(2)} bps` : '—'}</dd>
          <dt>REST sync</dt><dd className={syncFresh ? '' : 'down'}>{sync ? `${bps(sync.driftBps, 2)} bps` : '—'}</dd>
        </dl>
        <div className="seg" role="group" aria-label="Candle interval">
          {(['1s', '1m'] as Frame[]).map((f) => (
            <button key={f} aria-pressed={frame === f} onClick={() => setFrame(f)}>{f === '1s' ? '1 second' : '1 minute'}</button>
          ))}
        </div>
      </div>

      <BtcChart frame={frame} />

      <div className="signals">
        <div className="signal"><span>Order book imbalance</span><b className={sig && sig.obi > 0.2 ? 'up' : sig && sig.obi < -0.2 ? 'down' : ''}>{sig ? `${sig.obi > 0 ? '+' : ''}${(sig.obi * 100).toFixed(0)}%` : '—'}</b></div>
        <div className="signal"><span>1s return z-score</span><b className={ready && Math.abs(sig!.retZ) > 3 ? 'hot' : ''}>{ready ? sig!.retZ.toFixed(2) : warm}</b></div>
        <div className="signal"><span>60s realised vol</span><b>{ready ? `${sig!.volBps.toFixed(1)} bps` : warm}</b></div>
        <div className="signal"><span>Drift detector (trips at 6)</span><b>{ready ? `${sig!.cusumUp.toFixed(1)} up · ${sig!.cusumDown.toFixed(1)} down` : warm}</b></div>
        <div className="signal"><span>Regime</span><b className={regime.cls}><regime.icon size={16} aria-hidden />{regime.label}</b></div>
        <div className="signal"><span>Trade feed lag</span><b>{tick?.feed.feedLagMs != null ? `${tick.feed.feedLagMs} ms` : '—'}</b></div>
      </div>
    </section>
  );
}
