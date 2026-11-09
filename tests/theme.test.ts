import assert from 'node:assert/strict';
import test from 'node:test';
import { isLight, parsePreference } from '../web/themePreference.ts';

test('the stored theme resolves the same in every window: light, dark, or the system appearance', () => {
  assert.equal(parsePreference('light'), 'light');
  assert.equal(parsePreference('system'), 'system');
  assert.equal(parsePreference('dark'), 'dark');
  assert.equal(parsePreference(null), 'dark', 'nothing saved yet');
  assert.equal(parsePreference('neon'), 'dark');
  assert.equal(isLight('light', false), true);
  assert.equal(isLight('dark', true), false);
  assert.equal(isLight('system', true), true);
  assert.equal(isLight('system', false), false);
});

test('a window that stays open (the quick window) follows a theme change made in another one', async () => {
  // Just enough of a browser for web/theme.ts: storage, a media query, and the <html> class list.
  const store = new Map<string, string>([['agentscode:theme', 'dark']]);
  const classes = new Set<string>();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const media = Object.assign(new EventTarget(), { matches: false });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) } },
  });
  win.matchMedia = () => media;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  try {
    // Through a variable: the server type check (no DOM types) must not follow it into web/theme.ts.
    const themeModule = '../web/theme.ts';
    await import(themeModule);
    assert.equal(classes.has('theme-light'), false, 'opens dark, as saved');
    // The main window saves light: the storage event reaches this window.
    store.set('agentscode:theme', 'light');
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'agentscode:theme' }));
    assert.equal(classes.has('theme-light'), true, 'turns light live');
    // Back to system on a dark Mac, missed as an event: coming to the front catches it.
    store.set('agentscode:theme', 'system');
    win.dispatchEvent(new Event('focus'));
    assert.equal(classes.has('theme-light'), false);
    // The system turns light: the media query follows.
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(classes.has('theme-light'), true, 'system follows the OS appearance');
  } finally {
    delete g.window;
    delete g.document;
    delete g.localStorage;
  }
});
