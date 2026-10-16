import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store';
import { bps, reducedMotion, usePalette } from '../format';

const GLOW_MS = 2400;
const AXIS_W = 44;

// Every triangular cycle as one bar, in a fixed position (most liquid on the
// left) so the operator learns the landscape. Bars hang below zero while a
// cycle loses money after fees; a bar that pierces the entry line lights amber
// and leaves an afterglow so a 50 ms window is still visible to a human.
export function Seismograph() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pal = usePalette();
  const { cycles, tick, settings } = useStore();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const dom = useRef({ lo: -60, hi: 20 });

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    let lastVersion = -1;
    const reduce = reducedMotion();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const s = store.state;
      const glowing = !reduce && [...s.flashes.values()].some((t) => now - t < GLOW_MS);
      if (store.version === lastVersion && !glowing) return;
      lastVersion = store.version;

      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const edges = s.tick?.edge ?? [];
      const min = s.settings?.minEdgeBps ?? 5;
      const vals = edges.filter((e): e is number => e !== null).sort((a, b) => a - b);
      const targetLo = Math.min(-25, vals.length ? vals[0] : -100);
      const targetHi = Math.max(min + 10, vals.length ? vals[vals.length - 1] + 6 : 20);
      dom.current.lo += (targetLo - dom.current.lo) * 0.15;
      dom.current.hi += (targetHi - dom.current.hi) * 0.15;
      const { lo, hi } = dom.current;
      // Signed square-root scale: keeps resolution near breakeven, where
      // decisions happen, while still fitting cycles that are hundreds of bps under.
      const f = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v));
      const top = 10, bottom = H - 6;
      const y = (v: number) => top + ((f(hi) - f(Math.max(lo, Math.min(hi, v)))) / (f(hi) - f(lo))) * (bottom - top);

      // Reference lines: zero is breakeven after fees.
      ctx.font = '500 11px Barlow, system-ui';
      ctx.textBaseline = 'middle';
      let lastLabel = y(0);
      for (const r of [-10, -30, -100, -300, -1000]) {
        if (r < lo) break;
        ctx.fillStyle = withAlpha(pal.line, 0.6);
        ctx.fillRect(AXIS_W, Math.round(y(r)), W - AXIS_W, 1);
        if (y(r) - lastLabel < 12) continue;
        lastLabel = y(r);
        ctx.fillStyle = pal.ink3;
        ctx.fillText(`${r}`, 4, y(r));
      }
      ctx.fillStyle = pal.ink3;
      ctx.fillRect(AXIS_W, Math.round(y(0)), W - AXIS_W, 1);
      ctx.fillText('0', 4, y(0));

      const n = edges.length;
      if (!n) return;
      const slot = (W - AXIS_W) / n;
      const gap = slot > 5 ? 2 : slot > 2.5 ? 1 : 0;
      const bw = Math.max(1, slot - gap);
      const y0 = y(0);

      for (let i = 0; i < n; i++) {
        const e = edges[i];
        const x = AXIS_W + i * slot;
        const flash = s.flashes.get(i);
        const age = flash === undefined ? Infinity : now - flash;
        if (!reduce && age < GLOW_MS) {
          const a = 0.32 * (1 - age / GLOW_MS) ** 2;
          ctx.fillStyle = withAlpha(pal.amber, a);
          ctx.fillRect(x - gap / 2, top, slot, bottom - top);
        }
        if (e === null) continue;
        const ye = y(e);
        ctx.fillStyle = e >= min ? pal.amber : e >= 0 ? pal.ink2 : withAlpha(pal.ink3, 0.6);
        const h = Math.max(1, Math.abs(ye - y0));
        ctx.fillRect(x, Math.min(ye, y0), bw, h);
        if (hover?.i === i) {
          ctx.fillStyle = pal.ink;
          ctx.fillRect(x, Math.min(ye, y0), bw, h);
        }
      }

      // Entry threshold drawn last so it reads over the bars.
      ctx.fillStyle = pal.amber;
      ctx.fillRect(AXIS_W, Math.round(y(min)), W - AXIS_W, 1);
      ctx.fillText(`+${min}`, 4, y(min));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pal, hover?.i]);

  const n = tick?.edge.length ?? cycles.length;
  const onMove = (ev: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x = ev.clientX - r.left;
    if (x < AXIS_W || !n) return setHover(null);
    const i = Math.min(n - 1, Math.floor(((x - AXIS_W) / (r.width - AXIS_W)) * n));
    setHover({ i, x, y: ev.clientY - r.top });
  };

  const min = settings?.minEdgeBps ?? 5;
  const above = tick ? tick.edge.filter((e) => e !== null && e >= min).length : 0;
  const best = tick?.top[0];
  const hc = hover ? cycles[hover.i] : null;
  const he = hover && tick ? tick.edge[hover.i] : null;

  return (
    <section className="panel span-12" aria-labelledby="seismo-title">
      <div className="panel-head">
        <div>
          <h2 className="panel-title" id="seismo-title">Dislocation seismograph</h2>
          <p className="panel-note">
            {n} triangular cycles, each bar its net edge after {settings ? `3 × ${settings.feeBps} bps` : ''} fees, updated on every book change.
          </p>
        </div>
        <div className="legend" aria-hidden>
          <span><i style={{ background: 'var(--amber)' }} />Clears entry ({above} now)</span>
          <span><i style={{ background: 'var(--ink-2)' }} />Profitable, below entry</span>
          <span><i style={{ background: 'var(--ink-3)', opacity: 0.6 }} />Loses after fees</span>
          <span><i className="line" style={{ background: 'var(--amber)' }} />Entry line</span>
        </div>
      </div>
      <div
        ref={box}
        className="seismo-box"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${n} cycles scanned. ${above} above the ${min} bps entry line. Best cycle ${best ? `${cycles[best.id]?.label} at ${bps(best.edge)} bps` : 'not yet priced'}.`}
        />
        {hover && hc && (
          <div className="tooltip" style={{ left: Math.min(hover.x + 14, (box.current?.clientWidth ?? 0) - 220), top: Math.max(0, hover.y - 70) }}>
            <b className="num">{bps(he, 2)} bps</b>
            <div>{hc.label}</div>
            <div className="tt-label">{hc.legs.join(' · ')}</div>
            <div className="tt-label">z-score {tick?.z[hover.i]?.toFixed(1) ?? '—'}</div>
          </div>
        )}
      </div>
      <div className="seismo-axis"><span>Most liquid cycles</span><span>Net edge in bps, square-root scale</span><span>Least liquid</span></div>
    </section>
  );
}

function withAlpha(hex: string, a: number) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}
