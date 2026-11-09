/**
 * The quick composer inside the app (Shift+Cmd+Space in a browser tab, where there is no floating
 * window). The desktop app opens the same composer in its own window over any app instead
 * (electron/quickWindow.ts, web/quick/main.tsx).
 */
import { open } from '../layout.ts';
import { QuickComposer } from '../quick/QuickComposer.tsx';
import { Modal } from '../mono/Modal.tsx';

export function SuperQuickBar({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Quick composer" size="md" minimalHeader hideClose onClose={onClose}>
      <QuickComposer
        mode="modal"
        onDismiss={onClose}
        onOpenAgent={agentId => { onClose(); open({ kind: 'agent', agentId }); }}
      />
    </Modal>
  );
}
