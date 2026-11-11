// First: carry localStorage over from the old AgentsCode keys (web/storageMigration.ts).
import './storageMigration.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { IS_DESKTOP_APP } from './platform.ts';
import { connect } from './store.ts';
import './theme.ts';
import './styles.css';

// The macOS desktop app's window has no title bar (electron/main.ts); the `desktop` variant in
// styles.css makes room for its traffic lights and lets the headers drag the window.
if (IS_DESKTOP_APP) document.documentElement.classList.add('desktop-app');

connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
