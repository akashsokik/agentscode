/**
 * What agents do inside a browser tab, through the Chrome DevTools Protocol on the tab's own
 * webContents.debugger: read the accessibility tree, click and type at elements it named, press
 * keys, capture the page and evaluate script. No Playwright: Electron already speaks CDP.
 *
 * The debugger attaches on first use, after the tab has loaded something (CDP on a tab that has
 * never navigated does not answer).
 */
import type { WebContents } from 'electron';
import { formatAXTree, keyEvent, PRESSABLE_KEYS, type AXNode } from '../shared/browserPolicy.ts';
import { BrowserError } from './browserError.ts';

const EVAL_LIMIT = 20_000;

export class Cdp {
  private attached = false;
  /** Refs from the last snapshot to DOM nodes; a navigation clears them. */
  private refs = new Map<string, number>();

  private wc: WebContents;

  constructor(wc: WebContents) {
    this.wc = wc;
    wc.debugger.on('detach', () => {
      this.attached = false;
    });
  }

  private async send<T = Record<string, unknown>>(method: string, params?: object): Promise<T> {
    if (this.wc.isDestroyed()) throw new BrowserError('That browser tab is closed.');
    if (!this.attached) {
      if (!this.wc.getURL()) throw new BrowserError('Nothing is loaded in this tab yet. Call browser_open first.');
      try {
        this.wc.debugger.attach('1.3');
      } catch (err) {
        // Already attached (by an earlier Cdp for this contents): use it.
        if (!/already attached/i.test(String(err))) throw err;
      }
      this.attached = true;
    }
    return this.wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  forgetRefs(): void {
    this.refs.clear();
  }

  detach(): void {
    if (!this.attached || this.wc.isDestroyed()) return;
    try {
      this.wc.debugger.detach();
    } catch {
      // gone already
    }
    this.attached = false;
  }

  async snapshot(maxChars: number): Promise<{ text: string; truncated: boolean }> {
    const { nodes } = await this.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const { text, refs, truncated } = formatAXTree(nodes, maxChars);
    this.refs = refs;
    return { text: text || '(The page has no readable content yet.)', truncated };
  }

  private node(ref: string): number {
    const id = this.refs.get(ref.replace(/^\[|\]$/g, ''));
    if (id === undefined) throw new BrowserError(`No element ${ref}. Refs come from the latest browser_snapshot and reset when the page navigates; take a new snapshot.`);
    return id;
  }

  /** The centre of an element, scrolled into view first, in viewport coordinates. */
  private async centre(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    let quad: number[];
    try {
      const { model } = await this.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId });
      quad = model.content;
    } catch {
      throw new BrowserError('That element is not on screen (hidden, or removed since the snapshot). Take a new snapshot.');
    }
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  }

  /**
   * Input from CDP only reaches a page Chromium considers on screen: with the window closed or
   * minimized it is dropped without an error. So each action first listens for its own event in
   * the page, and when that never arrives, does the same thing with DOM events instead. The
   * result says which happened, so nobody takes a dropped click for a real one.
   */
  private async prepareInput(): Promise<void> {
    // Keys reach a page only while it has focus; emulate it so an agent's typing never needs the
    // user's focus. A cross-site navigation swaps the renderer, so this is sent every time.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  private async objectId(backendNodeId: number): Promise<string> {
    const { object } = await this.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
    if (!object.objectId) throw new BrowserError('That element is gone. Take a new snapshot.');
    return object.objectId;
  }

  private async call<T = unknown>(objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const { result, exceptionDetails } = await this.send<{ result: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) throw new BrowserError(`The page refused the action: ${exceptionDetails.text ?? 'an error'}.`);
    return result.value as T;
  }

  /**
   * Listens for any of `types` in the element's document (or the focused one, for keys). For a
   * click, also notes what the first event hit: the element, or something covering it.
   */
  private watch(objectId: string, types: string[], focused: boolean): Promise<void> {
    return this.call(objectId, `function (types, focused) {
      const target = focused ? null : this;
      let doc = this.ownerDocument || this;
      if (focused) { try { while (doc.activeElement && doc.activeElement.contentDocument) doc = doc.activeElement.contentDocument; } catch (e) {} }
      const w = doc.defaultView;
      const old = w.__agentscodeWatch;
      if (old) for (const t of old.types) w.removeEventListener(t, old.fn, true);
      w.__agentscodeSeen = null;
      const fn = (e) => {
        if (w.__agentscodeSeen !== null) return;
        if (!target || e.target === target || (e.target instanceof Node && target.contains(e.target))) { w.__agentscodeSeen = ''; return; }
        const hit = e.target instanceof Element ? e.target : null;
        const name = hit ? (hit.getAttribute('aria-label') || hit.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) : '';
        w.__agentscodeSeen = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (name ? ' "' + name + '"' : '') : 'another element';
      };
      w.__agentscodeWatch = { types, fn };
      for (const t of types) w.addEventListener(t, fn, true);
      globalThis.__agentscodeWin = w;
    }`, [types, focused]);
  }

  /**
   * What the watch saw, and stops it: null when nothing arrived, '' when the input reached the
   * element, or a description of the element it hit instead.
   */
  private async seen(objectId: string): Promise<string | null> {
    return this.call<string | null>(objectId, `function () {
      const w = globalThis.__agentscodeWin || window;
      const seen = w.__agentscodeSeen === undefined ? null : w.__agentscodeSeen;
      const old = w.__agentscodeWatch;
      if (old) for (const t of old.types) w.removeEventListener(t, old.fn, true);
      w.__agentscodeWatch = undefined;
      return seen;
    }`).catch(() => ''); // the page navigated away: the input arrived
  }

  async click(ref: string): Promise<'trusted' | 'synthetic'> {
    const backendNodeId = this.node(ref);
    const { x, y } = await this.centre(backendNodeId);
    const objectId = await this.objectId(backendNodeId);
    await this.prepareInput();
    await this.watch(objectId, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], false);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    const seen = await this.seen(objectId);
    if (seen === '') return 'trusted';
    if (seen !== null) throw new BrowserError(`The click landed on ${seen}, which covers that element. Close it first, or take a new snapshot.`);
    // Before clicking by DOM events, make sure a person could have: nothing may cover the element
    // where it would be clicked. this.click() alone would reach it under a modal.
    const cover = await this.call<string | null>(objectId, `function (x, y) {
      const hit = this.ownerDocument.elementFromPoint(x, y);
      if (!hit || hit === this || this.contains(hit) || (hit.control && hit.control === this)) return null;
      const name = (hit.getAttribute('aria-label') || hit.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
      return hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (name ? ' "' + name + '"' : '');
    }`, [x, y]);
    if (cover) throw new BrowserError(`Something covers that element where it would be clicked: ${cover}. Close it first, or take a new snapshot.`);
    await this.call(objectId, `function (x, y) {
      const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: this.ownerDocument.defaultView };
      this.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse', isPrimary: true }));
      this.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
      if (typeof this.focus === 'function') this.focus();
      this.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
      this.dispatchEvent(new MouseEvent('mouseup', at));
      if (typeof this.click === 'function') this.click(); else this.dispatchEvent(new MouseEvent('click', at));
    }`, [x, y]);
    return 'synthetic';
  }

  async type(ref: string, text: string, submit: boolean): Promise<'trusted' | 'synthetic'> {
    const backendNodeId = this.node(ref);
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    await this.prepareInput();
    try {
      await this.send('DOM.focus', { backendNodeId });
    } catch {
      throw new BrowserError('That element cannot take typing. Pick a textbox, searchbox or combobox from the snapshot.');
    }
    // Select what the field holds, so the text replaces it rather than adding to it.
    const objectId = await this.objectId(backendNodeId);
    await this.call(objectId, 'function () { if (typeof this.select === "function") this.select(); else if (this.isContentEditable) this.ownerDocument.getSelection().selectAllChildren(this); }').catch(() => {});
    // insertText goes through the editing path, which works on screen or not.
    await this.send('Input.insertText', { text });
    return submit ? this.press('Enter') : 'trusted';
  }

  async press(key: string): Promise<'trusted' | 'synthetic'> {
    const event = keyEvent(key);
    if (!event) throw new BrowserError(`Unknown key ${key}. Use one of: ${PRESSABLE_KEYS.join(', ')}.`);
    await this.prepareInput();
    const { result } = await this.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document' });
    const doc = result.objectId;
    if (doc) await this.watch(doc, ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'], true);
    await this.send('Input.dispatchKeyEvent', { type: event.text ? 'keyDown' : 'rawKeyDown', ...event });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode });
    if (!doc || (await this.seen(doc)) !== null) return 'trusted';
    // The DOM version of the key: its events, then what the key would have done.
    await this.call(doc, `function (key, code) {
      let doc = this;
      try { while (doc.activeElement && doc.activeElement.contentDocument) doc = doc.activeElement.contentDocument; } catch (e) {}
      const el = doc.activeElement || doc.body;
      const init = { key, code, bubbles: true, cancelable: true, composed: true };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
      if (go) {
        const editable = 'value' in el && typeof el.setRangeText === 'function';
        if (key.length === 1 && editable) { el.setRangeText(key, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end'); el.dispatchEvent(new InputEvent('input', { bubbles: true, data: key, inputType: 'insertText' })); }
        else if (key === 'Backspace' && editable) {
          const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
          el.setRangeText('', s === e ? Math.max(0, s - 1) : s, e, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        } else if (key === 'Enter') {
          if (el.form && el.tagName === 'INPUT') el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
          else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') el.click();
        } else if (key === 'Tab') {
          const all = [...doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
          const next = all[(all.indexOf(el) + 1) % all.length];
          if (next) next.focus();
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }`, [event.key, event.code]);
    return 'synthetic';
  }

  /**
   * A PNG of the viewport, or of the whole page when asked and the page allows it in time, at
   * CSS pixels: a Retina screen would otherwise double every side for no extra use to an agent.
   */
  async screenshot(fullPage: boolean): Promise<{ png: Buffer; fullPage: boolean }> {
    const metrics = await this.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }; cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
    const { result } = await this.send<{ result: { value?: number } }>('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
    const scale = 1 / (result.value && result.value > 0 ? result.value : 1);
    const view = metrics.cssVisualViewport;
    if (fullPage) {
      const size = metrics.cssContentSize;
      const clip = { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 16_000), scale };
      // A tab no pane shows cannot always lay out beyond its viewport; fall back to the viewport.
      const full = await Promise.race([
        this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip }).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
      ]);
      if (full) return { png: Buffer.from(full.data, 'base64'), fullPage: true };
    }
    const clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale };
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip });
    return { png: Buffer.from(data, 'base64'), fullPage: false };
  }

  async evaluate(expression: string): Promise<{ type: string; value: string }> {
    if (!expression.trim()) throw new BrowserError('Give an expression to evaluate.');
    const result = await this.send<{ result: { type: string; value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 8000,
    });
    if (result.exceptionDetails) {
      throw new BrowserError(`The expression threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'an error'}`.slice(0, EVAL_LIMIT));
    }
    const { type, value, description } = result.result;
    let text: string;
    if (value === undefined) text = description ?? type;
    else if (typeof value === 'string') text = value;
    else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    return { type, value: text.length > EVAL_LIMIT ? `${text.slice(0, EVAL_LIMIT)}… (cut at ${EVAL_LIMIT} characters)` : text };
  }
}
