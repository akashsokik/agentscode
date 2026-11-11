/**
 * A browser tab. In the desktop app the page itself is a native view main lays over this pane's
 * body (electron/browser.ts); the pane keeps it at the body's bounds every frame, hides it when
 * the tab leaves the screen, and shows a still of it while a dialog or menu is open over it.
 * In a plain browser tab, localhost pages show in an iframe and anything else opens outside.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isLocalUrl, normalizeAddress, type BrowserTabState } from '../../shared/browser.ts';
import { browserCall, coveredBy, HAS_NATIVE_BROWSER, onAddressFocus, primeBrowserTab, useBrowserTab } from '../browser.ts';
import { useApp } from '../store.ts';
import { ChevronLeft, ChevronRight, Code, ExternalLink, Globe, RefreshCw, X } from '../mono/icons.tsx';
import { Empty, HeaderButton, TextButton } from '../ui/common.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

interface Props {
  id: string;
  url: string;
  agentId: string | null;
  chrome: PaneChrome;
}

/** The part of the body no floating panel covers: the right panel floats over panes below 1280px. */
function visibleRect(body: HTMLElement): DOMRect {
  const rect = body.getBoundingClientRect();
  const panel = document.querySelector<HTMLElement>('aside[aria-label="Panel"]');
  if (panel && getComputedStyle(panel).position === 'absolute') {
    const p = panel.getBoundingClientRect();
    if (p.left < rect.right && p.right > rect.left && p.width > 0) return new DOMRect(rect.x, rect.y, Math.max(0, p.left - rect.x), rect.height);
  }
  return rect;
}

function AddressBar({ id, url, onSubmit }: { id: string; url: string; onSubmit: (value: string) => void }) {
  const [draft, setDraft] = useState(url);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraft(url);
  }, [url, editing]);
  useEffect(() => onAddressFocus(target => {
    if (target !== id) return;
    input.current?.focus();
    input.current?.select();
  }), [id]);
  // A new blank tab starts with the caret in its address bar.
  useEffect(() => {
    if (!url) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(draft);
    setEditing(false);
    input.current?.blur();
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1">
      <input
        ref={input}
        value={draft}
        onChange={e => { setDraft(e.target.value); setEditing(true); }}
        onFocus={e => { setEditing(true); e.currentTarget.select(); }}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(url); setEditing(false); e.currentTarget.blur(); } }}
        spellCheck={false}
        aria-label="Address"
        placeholder="Type an address, like localhost:3000"
        className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-content/5 px-2 font-mono text-[11.5px] font-normal text-content/80 outline-none placeholder:font-sans placeholder:text-content/35 focus:border-content/15 focus:bg-background-base"
      />
    </form>
  );
}

function DriverBar({ tab }: { tab: BrowserTabState }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === tab.agentId));
  if (!tab.agentId) return null;
  const name = agent?.name ?? 'An agent';
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-stroke px-3 font-sans text-[11.5px] text-content/55">
      <span className={`size-1.5 shrink-0 rounded-full ${tab.driving && !tab.paused ? 'bg-content/70' : 'bg-content/25'}`} />
      <span className="min-w-0 truncate">
        {tab.paused ? `You have this tab. ${name} waits until you hand it back.` : tab.driving ? `${name} is using this tab` : `${name}'s tab`}
      </span>
      <TextButton className="ml-auto" onClick={() => void browserCall('pause', { id: tab.id, paused: !tab.paused })}>
        {tab.paused ? 'Hand back' : 'Take over'}
      </TextButton>
    </div>
  );
}

function NativeBody({ id, tab, onRetry }: { id: string; tab: BrowserTabState | undefined; onRetry: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  const coveredRef = useRef(false);
  // A still of the page while something covers it: null for none, '' when the capture came back empty.
  const [still, setStill] = useState<string | null>(null);
  const failure = tab?.failure ?? null;
  const blank = !tab?.url || tab.url === 'about:blank';
  const live = !failure && !blank;

  // Keep the view on the body's bounds, every frame: panes split, columns drag, the terminal
  // grows, and none of that resizes the window. While a dialog or menu covers the pane, the
  // view stays down (the effect below hides it once the still is up).
  useEffect(() => {
    const el = body.current;
    if (!el || !live) {
      void browserCall('hide', { id }).catch(() => {});
      return;
    }
    let frame = 0;
    let last = '';
    const tick = () => {
      const r = visibleRect(el);
      const visible = r.width > 0 && r.height > 0 && document.visibilityState === 'visible';
      const isCovered = visible && coveredBy(r);
      if (isCovered !== coveredRef.current) {
        coveredRef.current = isCovered;
        setCovered(isCovered);
      }
      const key = isCovered ? 'covered' : visible ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}` : 'hidden';
      if (key !== last) {
        last = key;
        if (key === 'hidden') void browserCall('hide', { id }).catch(() => {});
        else if (key !== 'covered') void browserCall('show', { id, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }).catch(() => {});
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [id, live]);

  // Covered: take a still of the page as it is, put it in the view's place, then hide the view.
  useEffect(() => {
    if (!covered || !live) {
      setStill(null);
      return;
    }
    let cancelled = false;
    const done = (image: string | null) => {
      if (cancelled) return;
      setStill(image ?? '');
      void browserCall('hide', { id }).catch(() => {});
    };
    void browserCall<string | null>('capture', { id }).then(done, () => done(null));
    return () => { cancelled = true; };
  }, [covered, live, id]);

  // Leaving the screen (another tab in this pane, or the pane closed) hides the view.
  useEffect(() => () => { void browserCall('hide', { id }).catch(() => {}); }, [id]);

  return (
    <div ref={body} className="relative min-h-0 flex-1 bg-background-base">
      {failure ? (
        <Empty icon={Globe} title="This page did not load" action={<TextButton onClick={onRetry}>Try again</TextButton>}>
          <span className="break-all">{failure}</span>
        </Empty>
      ) : blank ? (
        <Empty icon={Globe} title="New browser tab">Type an address above. Links to localhost from transcripts and terminals open here too.</Empty>
      ) : covered && still ? (
        <img src={still} alt="" className="absolute inset-0 size-full object-cover object-left-top" draggable={false} />
      ) : null}
    </div>
  );
}

function FallbackBody({ url, reloadKey }: { url: string; reloadKey: number }) {
  if (!url) return <Empty icon={Globe} title="New browser tab">Type a localhost address above to preview it here.</Empty>;
  if (!isLocalUrl(url)) {
    return (
      <Empty icon={Globe} title="Opens outside PodCode" action={<TextButton onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>Open in your browser</TextButton>}>
        Only localhost pages show here when PodCode runs in a browser. The desktop app opens any page.
      </Empty>
    );
  }
  return <iframe key={reloadKey} src={url} title="Preview" className="min-h-0 w-full flex-1 border-0 bg-background-base" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals" />;
}

export function BrowserPane({ id, url, agentId, chrome }: Props) {
  const tab = useBrowserTab(id);
  const [fallbackUrl, setFallbackUrl] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!HAS_NATIVE_BROWSER) return;
    void browserCall<BrowserTabState>('create', { id, url }).then(primeBrowserTab, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const shownUrl = HAS_NATIVE_BROWSER ? (tab?.url && tab.url !== 'about:blank' ? tab.url : url) : fallbackUrl;
  const go = (value: string) => {
    const target = normalizeAddress(value);
    if (!target) return;
    if (HAS_NATIVE_BROWSER) void browserCall('navigate', { id, url: target }).catch(() => {});
    else setFallbackUrl(target);
  };
  const call = (op: string) => () => void browserCall(op, { id }).catch(() => {});
  const loading = Boolean(tab?.loading);

  const title = (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <HeaderButton icon={ChevronLeft} label="Back" disabled={!tab?.canGoBack} onClick={call('back')} />
      <HeaderButton icon={ChevronRight} label="Forward" disabled={!tab?.canGoForward} onClick={call('forward')} />
      <HeaderButton
        icon={loading ? X : RefreshCw}
        label={loading ? 'Stop' : 'Reload'}
        onClick={HAS_NATIVE_BROWSER ? call(loading ? 'stop' : 'reload') : () => setReloadKey(k => k + 1)}
      />
      <AddressBar id={id} url={shownUrl} onSubmit={go} />
    </div>
  );
  const actions = HAS_NATIVE_BROWSER ? (
    <>
      {tab?.errors ? (
        <button type="button" onClick={call('devtools')} title="Open DevTools to see them" className="shrink-0 rounded-md px-1.5 font-sans text-[11px] font-normal text-danger/85 hover:bg-content/8">
          {tab.errors} {tab.errors === 1 ? 'error' : 'errors'}
        </button>
      ) : null}
      <HeaderButton icon={Code} label="DevTools" onClick={call('devtools')} />
      <HeaderButton icon={ExternalLink} label="Open in your browser" disabled={!tab?.url || tab.url === 'about:blank'} onClick={call('external')} />
    </>
  ) : shownUrl ? (
    <HeaderButton icon={ExternalLink} label="Open in your browser" onClick={() => window.open(shownUrl, '_blank', 'noopener,noreferrer')} />
  ) : null;

  return (
    <PaneFrame chrome={chrome} title={title} actions={actions}>
      {tab && agentId ? <DriverBar tab={tab} /> : null}
      {HAS_NATIVE_BROWSER
        ? <NativeBody id={id} tab={tab} onRetry={() => go(shownUrl)} />
        : <FallbackBody url={fallbackUrl} reloadKey={reloadKey} />}
    </PaneFrame>
  );
}
