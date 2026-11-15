import { StatusMark } from '../ui/StatusMark.tsx';
/**
 * Settings > About's rows that need more than a control (web/panes/SettingsPage.tsx): the update
 * state with Check for updates, and the install command for an unsigned Mac build. The update
 * state comes from electron/updater.ts through the preload bridge; in a browser there is none, and About says so.
 */
import { useEffect, useRef, useState } from 'react';
import { updateStatusText } from '../../shared/buildInfo.ts';
import { MAC_INSTALL_COMMAND, type UpdateSnapshot } from '../../shared/updates.ts';
import { ArrowDownCircle, Check, Copy, RefreshCw } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Row } from '../mono/settings.tsx';

export function UpdatesRow({ snapshot }: { snapshot: UpdateSnapshot }) {
  const updates = window.podcodeDesktop?.updates;
  const busy = snapshot.phase === 'checking' || snapshot.phase === 'downloading' || snapshot.phase === 'ready';
  const available = snapshot.phase === 'available' && snapshot.availableVersion;
  return (
    <Row id="updates" label="Updates" description={updateStatusText(snapshot)}>
      <SecondaryButton disabled={busy || !updates} onClick={() => void (available ? updates?.install() : updates?.check())}>
        {available
          ? <ArrowDownCircle className="size-3.5" strokeWidth={1.75} />
          : <>{snapshot.phase === 'checking' ? <StatusMark state="pending" className="size-3.5" /> : <RefreshCw className="size-3.5" strokeWidth={1.75} />}</>}
        {available ? `Update to ${snapshot.availableVersion}` : 'Check for updates'}
      </SecondaryButton>
    </Row>
  );
}

/** Full width: the command is too long for a row's control column. */
export function InstallCommandRow() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(MAC_INSTALL_COMMAND).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div id="install-command" className="settings-row border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="text-[13px] font-medium text-content">Install or update from Terminal</div>
      <p className="mt-1 text-[12px] leading-relaxed text-content/45">
        This build is not signed with an Apple Developer ID yet, so it cannot replace itself. Quit PodCode and run this to install the latest version.
      </p>
      <div className="mt-2.5 flex items-center gap-2 rounded-md bg-content/5 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content/75" title={MAC_INSTALL_COMMAND}>{MAC_INSTALL_COMMAND}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy install command"
          className="flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[12px] text-content/60 transition-colors duration-150 hover:bg-content/10 hover:text-content"
        >
          {copied ? <Check className="size-3.5" strokeWidth={1.75} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
