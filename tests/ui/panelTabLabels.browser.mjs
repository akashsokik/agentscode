/** Reusable Playwright check against a built app with fake agents, never the real user's data.
 * Call in a fresh authenticated context; no app server is started by this check.
 * spec: { origin, agentId, projectId, panelType: 'agent'|'super', artifactDir }
 */
export async function checkPanelTabLabels(page, spec) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(({ agentId, projectId }) => {
    const width = Number(new URLSearchParams(location.search).get('panel-width')) || 320;
    localStorage.setItem('podcode:layout', JSON.stringify({
      tabs: [{ id: 'fixture', content: { kind: 'agent', agentId } }],
      panes: [{ id: 'pane', tabId: 'fixture' }], focused: 'pane', sidebar: true, rail: false,
      projectId, rightPanel: true, rightView: 'notes', superView: 'notes',
      superPanelShown: true, widths: { panel: width },
    }));
  }, spec);
  const tabs = spec.panelType === 'super'
    ? ['overview', 'decisions', 'issues', 'routines', 'comms', 'notes', 'work']
    : ['overview', 'comms', 'changes', 'notes', 'work'];
  const results = [];
  for (const width of [260, 320, 372]) {
    await page.goto(`${spec.origin}/?panel-width=${width}`);
    await page.waitForFunction(width => {
      const panel = document.querySelector('aside[aria-label="Panel"]');
      return panel?.getBoundingClientRect().width === width && document.querySelector('#panel-tab-notes');
    }, width);
    for (const view of tabs) {
      const tab = page.locator(`#panel-tab-${view}`);
      if (await tab.count()) await tab.click();
      else {
        await page.locator('button[aria-label^="More:"]').click();
        const title = view[0].toUpperCase() + view.slice(1);
        await page.getByRole('menuitem', { name: new RegExp(`^${title}( \\(|$)`) }).click();
      }
      const frames = await page.evaluate(async () => {
        const result = [];
        // Sample during the former 200ms size transition, not only after it settles.
        for (let frame = 0; frame < 14; frame++) {
          await new Promise(requestAnimationFrame);
          for (const label of document.querySelectorAll('[id^="panel-tab-"] [data-tab-label]')) {
            const range = document.createRange();
            range.selectNodeContents(label.firstElementChild);
            const text = range.getBoundingClientRect();
            let ancestor = label;
            while (ancestor && ancestor.tagName !== 'ASIDE') {
              const style = getComputedStyle(ancestor);
              if (['hidden', 'clip'].includes(style.overflowX)) {
                const bounds = ancestor.getBoundingClientRect();
                if (text.left < bounds.left - 0.1 || text.right > bounds.right + 0.1) {
                  throw new Error(`Clipped ${label.textContent} at frame ${frame}: text ${text.left}..${text.right}, clip ${bounds.left}..${bounds.right}`);
                }
              }
              ancestor = ancestor.parentElement;
            }
          }
          result.push(frame);
        }
        return result.length;
      });
      const selected = page.locator('[id^="panel-tab-"][aria-selected="true"]');
      if (await selected.getAttribute('id') !== `panel-tab-${view}`) throw new Error(`Did not open ${view}`);
      if (await selected.locator('[data-tab-label]').count() !== 1) throw new Error(`Expected whole active label at ${width}px`);
      results.push({ width, view, frames, wholeLabel: true });
      if (width === 320 && view === 'notes') {
        await page.getByRole('complementary', { name: 'Panel' }).screenshot({ path: `${spec.artifactDir}/label-after-${spec.panelType}-320.png` });
      }
      if (width === 260 && view === 'overview') {
        await page.getByRole('complementary', { name: 'Panel' }).screenshot({ path: `${spec.artifactDir}/label-after-${spec.panelType}-260.png` });
      }
    }
  }
  return results;
}
