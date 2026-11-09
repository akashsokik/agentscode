/**
 * Settings > About: the version and build, the update state with Check for updates, the install
 * command for an unsigned Mac build, and the release notes. The update state comes from
 * electron/updater.ts through the preload bridge; in a browser there is none, and About says so.
 */
import { useEffect, useRef, useState } from 'react';
import { buildLabel, channelLabel, updateStatusText } from '../../shared/buildInfo.ts';
import { MAC_INSTALL_COMMAND, releaseNotesUrl, type UpdateSnapshot } from '../../shared/updates.ts';
import { BUILD } from '../buildInfo.ts';
import { IS_MAC } from '../platform.ts';
import { useDesktopUpdate } from '../sidebar/SidebarUpdate.tsx';
import { ArrowDownCircle, Check, Copy, ExternalLink, RefreshCw } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row } from '../mono/settings.tsx';

export function AboutGroup() {
  const snapshot = useDesktopUpdate();
  const version = snapshot?.currentVersion || BUILD.version;
  return (
    <Group id="settings-about" title="About">
      <Row label={`AgentsCode ${version || ''}`.trim()} description={buildLabel(BUILD)}>
        <span className="text-[12px] text-content/45">{channelLabel(version)}</span>
      </Row>
      {snapshot ? <UpdatesRow snapshot={snapshot} /> : <Row label="Updates" description="Updates are managed by the desktop app." />}
      {snapshot && IS_MAC && !snapshot.canInstall ? <InstallCommandRow /> : null}
      {version ? (
        <Row label="Release notes" description={`What changed in ${version}.`}>
          <SecondaryButton onClick={() => window.open(releaseNotesUrl(version), '_blank')}>
            <ExternalLink className="size-3.5" strokeWidth={1.75} /> Open on GitHub
          </SecondaryButton>
        </Row>
      ) : null}
    </Group>
  );
}

function UpdatesRow({ snapshot }: { snapshot: UpdateSnapshot }) {
  const updates = window.agentscodeDesktop?.updates;
  const busy = snapshot.phase === 'checking' || snapshot.phase === 'downloading' || snapshot.phase === 'ready';
  const available = snapshot.phase === 'available' && snapshot.availableVersion;
  return (
    <Row label="Updates" description={updateStatusText(snapshot)}>
      <SecondaryButton disabled={busy || !updates} onClick={() => void (available ? updates?.install() : updates?.check())}>
        {available
          ? <ArrowDownCircle className="size-3.5" strokeWidth={1.75} />
          : <RefreshCw className={`size-3.5 ${snapshot.phase === 'checking' ? 'animate-spin' : ''}`} strokeWidth={1.75} />}
        {available ? `Update to ${snapshot.availableVersion}` : 'Check for updates'}
      </SecondaryButton>
    </Row>
  );
}

/** Full width: the command is too long for a row's control column. */
function InstallCommandRow() {
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
    <div className="settings-row border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="text-[13px] font-medium text-content">Install or update from Terminal</div>
      <p className="mt-1 text-[12px] leading-relaxed text-content/45">
        This build is not signed with an Apple Developer ID yet, so it cannot replace itself. Quit AgentsCode and run this to install the latest version.
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
