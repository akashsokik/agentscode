import type { ReactNode } from 'react';
import { closePane, focusPane, splitPane } from '../layout.ts';
import { PaneHeader } from '../mono/PaneHeader.tsx';
import { SplitRight, X } from '../mono/icons.tsx';
import { HeaderButton } from '../ui/common.tsx';

export interface PaneChrome {
  paneId: string;
  focused: boolean;
  canSplit: boolean;
  multiple: boolean;
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
        {chrome.canSplit ? <HeaderButton icon={SplitRight} label="Split right" onClick={() => splitPane(chrome.paneId)} /> : null}
        {chrome.multiple ? <HeaderButton icon={X} label="Close pane" onClick={() => closePane(chrome.paneId)} /> : null}
      </PaneHeader>
      {children}
    </section>
  );
}
