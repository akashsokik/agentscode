import type { ReactNode } from 'react';
import { closePane, focusPane, splitPane, toggleMaximize } from '../layout.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import { PaneHeader } from '../mono/PaneHeader.tsx';
import { Maximize2, Minimize2, SplitColumns, X } from '../mono/icons.tsx';
import { HeaderButton } from '../ui/common.tsx';

export interface PaneChrome {
  paneId: string;
  focused: boolean;
  canSplit: boolean;
  multiple: boolean;
  /** This pane fills the width while the others wait. */
  maximized?: boolean;
}

/**
 * One pane in MonoCode's Classic layout: flush in the main column, with a PaneHeader. With several panes open,
 * the ones without focus dim, the way MonoCode dims inactive title tabs.
 */
export function PaneFrame({ chrome, title, actions, children }: { chrome: PaneChrome; title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section
      onPointerDownCapture={() => focusPane(chrome.paneId)}
      // Tabbing into a pane makes it the focused one too, not only clicking.
      onFocusCapture={() => focusPane(chrome.paneId)}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <PaneHeader className={`transition-opacity duration-150 ${chrome.multiple && !chrome.focused ? 'opacity-65' : ''}`}>
        <div className="flex min-w-0 flex-1 items-center">{title}</div>
        {actions}
        {chrome.multiple ? (
          <HeaderButton
            icon={chrome.maximized ? Minimize2 : Maximize2}
            label={chrome.maximized ? 'Restore panes' : 'Maximize pane'}
            title={`${chrome.maximized ? 'Restore panes' : 'Maximize pane'} (${SHORTCUTS.maximize})`}
            active={chrome.maximized}
            aria-pressed={chrome.maximized}
            onClick={() => toggleMaximize(chrome.paneId)}
          />
        ) : null}
        {chrome.canSplit ? <HeaderButton icon={SplitColumns} label="Split right" onClick={() => splitPane(chrome.paneId)} /> : null}
        {chrome.multiple ? <HeaderButton icon={X} label="Close pane" onClick={() => closePane(chrome.paneId)} /> : null}
      </PaneHeader>
      {children}
    </section>
  );
}
