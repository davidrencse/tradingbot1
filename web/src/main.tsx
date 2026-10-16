import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { connect } from './store';
import { applyTheme, initialTheme } from './format';
import { TopBar, Banners } from './components/TopBar';
import { BtcPanel } from './components/BtcPanel';
import { PnlPanel } from './components/PnlPanel';
import { Seismograph } from './components/Seismograph';
import { CyclesTable } from './components/CyclesTable';
import { ExecutionLog } from './components/ExecutionLog';
import { Markets } from './components/Markets';
import { DepthPanel } from './components/DepthPanel';
import { Prediction } from './components/Prediction';
import { MakerPanel } from './components/MakerPanel';

applyTheme(initialTheme());
connect();

function App() {
  return (
    <main className="shell">
      <TopBar />
      <Banners />
      <BtcPanel />
      <PnlPanel />
      <Seismograph />
      <MakerPanel />
      <Prediction />
      <CyclesTable />
      <ExecutionLog />
      <Markets />
      <DepthPanel />
      <footer className="foot">
        Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>.
        Market data from Binance public streams. Not investment advice.
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
