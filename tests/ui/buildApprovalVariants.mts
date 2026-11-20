/** Build the component regression as a local file. No server, app data or providers are used.
 * node tests/ui/buildApprovalVariants.mts [output-directory]
 * Open the printed file URL; wait for body[data-result] and assert it equals "passed".
 */
import { build } from 'vite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const outDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(resolve(tmpdir(), 'podcode-approval-variants-'));
await build({
  configFile: false, base: './', logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir, emptyOutDir: false, minify: true, target: 'es2022',
    lib: { entry: fileURLToPath(new URL('../../docs/demos/ACH-67/build/approvalVariants.tsx', import.meta.url)), name: 'ApprovalVariantChecks', formats: ['iife'], fileName: () => 'checks.js' },
  },
});
const html = resolve(outDir, 'index.html');
writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>Approval variant regression</title><script defer src="./checks.js"></script>');
console.log(pathToFileURL(html).href);
