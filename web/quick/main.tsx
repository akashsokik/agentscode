/**
 * The desktop app's floating quick composer window (quick.html, electron/quickWindow.ts). It has
 * its own connection to the server, like the main window, and talks to the main process through
 * window.agentscodeDesktop.quick: its height, hiding, and opening an agent in the main window.
 */
import { StrictMode, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopQuick } from '../../shared/superAgent.ts';
import { QUICK_MARGIN } from '../../shared/superAgent.ts';
import { IS_DESKTOP_APP } from '../platform.ts';
import { connect } from '../store.ts';
import { QuickComposer } from './QuickComposer.tsx';
import '../theme.ts';
import '../styles.css';

const desktop = (window as unknown as { agentscodeDesktop?: { quick?: DesktopQuick } }).agentscodeDesktop?.quick ?? null;

// The drag strip uses the same rule as the main window's headers.
if (IS_DESKTOP_APP) document.documentElement.classList.add('desktop-app');

function QuickWindowApp() {
  const focus = useRef<() => void>(() => {});
  useEffect(() => desktop?.onShow(() => focus.current()), []);
  const onHeight = useCallback((height: number) => desktop?.fit(height), []);
  return (
    // A click in the clear margin around the card puts the window away, as one outside it does.
    <div style={{ padding: QUICK_MARGIN }} onMouseDown={e => { if (e.target === e.currentTarget) desktop?.hide(); }}>
      <QuickComposer
        mode="window"
        onDismiss={() => desktop?.hide()}
        onOpenAgent={agentId => desktop?.openInMain(agentId)}
        onHeight={onHeight}
        registerFocus={f => { focus.current = f; }}
      />
    </div>
  );
}

connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QuickWindowApp />
  </StrictMode>,
);
