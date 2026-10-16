import { useEffect, useState } from 'react';
import { Moon, OctagonX, Pause, Play, RotateCcw, Sun } from 'lucide-react';
import { send, useStore } from '../store';
import { applyTheme, compact, duration, initialTheme, micros, type Theme } from '../format';

function NumberField({ label, value, onCommit, step, min, disabled, suffix }: {
  label: string; value: number; onCommit: (v: number) => void; step: number; min: number; disabled?: boolean; suffix: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const commit = () => {
    const v = Number(draft);
    if (Number.isFinite(v) && v >= min && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <label className="field">
      {label}
      <input
        type="number" inputMode="decimal" step={step} min={min} value={draft} disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {suffix}
    </label>
  );
}

export function TopBar() {
  const { tick, settings, connection } = useStore();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);

  const f = tick?.feed;
  const sockets = f?.sockets ?? [];
  const up = sockets.filter((s) => s.connected).length;
  const healthy = connection === 'open' && sockets.length > 0 && up === sockets.length;
  const risk = tick?.risk;
  const live = settings?.mode === 'live';

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--panel)" />
          <path d="M5 20h5l3-9 4 14 3-9h7" fill="none" stroke="var(--amber)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1>Dislocation</h1>
        <span className="venue">{settings ? `${settings.venue} · ${settings.home} cycles` : 'connecting…'}</span>
        {settings && <span className={`mode ${live ? 'live' : 'paper'}`}>{live ? 'Live trading' : 'Paper trading'}</span>}
      </div>

      <div className="health" aria-label="Engine health">
        <div className="health-item">
          <b><span className={`live-dot ${healthy ? 'on' : connection === 'closed' ? 'off' : ''}`} aria-hidden />{connection === 'open' ? `${up}/${sockets.length} sockets` : connection === 'closed' ? 'Engine offline' : 'Connecting'}</b>
          <span>{f ? `up ${duration(f.uptimeSec)}` : '—'}</span>
        </div>
        <div className="health-item"><b>{f ? compact(f.msgsPerSec) : '—'}/s</b><span>book updates</span></div>
        <div className="health-item"><b>{f ? compact(f.evalsPerSec) : '—'}/s</b><span>cycle prices</span></div>
        <div className="health-item"><b>{f ? micros(f.latency.p50) : '—'}</b><span>tick to decision</span></div>
      </div>

      <div className="controls">
        <NumberField label="Entry" suffix="bps" step={0.5} min={live ? 1 : -50} value={settings?.minEdgeBps ?? 0} onCommit={(v) => send({ type: 'set', minEdgeBps: v })} />
        <NumberField label="Size" suffix={settings?.home ?? ''} step={10} min={1} value={settings?.tradeSize ?? 0} disabled={live} onCommit={(v) => send({ type: 'set', tradeSize: v })} />
        {risk?.paused ? (
          <button className="btn" onClick={() => send({ type: 'resume' })}><Play size={16} aria-hidden />Resume</button>
        ) : (
          <button className="btn" onClick={() => send({ type: 'pause' })} disabled={!tick}><Pause size={16} aria-hidden />Pause</button>
        )}
        <button className="btn danger" onClick={() => send({ type: 'halt' })} disabled={!tick || !!risk?.halted}><OctagonX size={16} aria-hidden />Kill switch</button>
        <button className="btn icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>
      </div>
    </header>
  );
}

export function Banners() {
  const { tick, connection } = useStore();
  const risk = tick?.risk;
  if (connection === 'closed') {
    return <div className="banner" role="alert">Lost the connection to the engine. Reconnecting automatically; check that <code>npm run engine</code> is still running.</div>;
  }
  if (risk?.halted) {
    return (
      <div className="banner" role="alert">
        Trading halted: {risk.halted}. Detection keeps running; no orders are sent.
        <button className="btn" onClick={() => send({ type: 'reset-halt' })}><RotateCcw size={16} aria-hidden />Clear halt</button>
      </div>
    );
  }
  if (risk?.paused) return <div className="banner warn" role="status">Execution paused. The scanner is still pricing every cycle.</div>;
  return null;
}
