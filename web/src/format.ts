import { useEffect, useState } from 'react';

export function decimalsFor(p: number) {
  if (!p) return 2;
  if (p >= 1000) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 6;
  return 8;
}

export const price = (p: number, d = decimalsFor(p)) =>
  p ? p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

export const bps = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;

export const money = (x: number, d = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;

export const compact = (x: number) =>
  Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x);

export const clock = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export const duration = (sec: number) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

export const micros = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} µs`);

// ── Theme ───────────────────────────────────────────────────────────────────
export type Theme = 'dark' | 'light';
const KEY = 'dislocation.theme';

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* storage unavailable */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Re-reads palette tokens whenever the theme attribute flips, so canvas and
// chart code (which cannot use CSS variables directly) stays in sync.
export function usePalette() {
  const read = () => ({
    bg: token('--panel'), ink: token('--ink'), ink2: token('--ink-2'), ink3: token('--ink-3'), line: token('--line'),
    amber: token('--amber'), teal: token('--teal'), coral: token('--coral'), blue: token('--blue'), panel2: token('--panel-2'),
  });
  const [p, setP] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setP(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return p;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
