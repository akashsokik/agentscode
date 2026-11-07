// The macOS arm64 and x64 apps build in separate CI jobs, and each writes its own latest-mac.yml
// listing only its own zip and dmg. electron-updater picks the file for its architecture from one
// combined list, so the release must carry a single latest-mac.yml with both. This joins the
// `files:` lists; everything else (version, top-level path and sha512, releaseDate) comes from the
// first file.
//
//   node scripts/release/merge-mac-yml.mjs <arm64 latest-mac.yml> <x64 latest-mac.yml> > latest-mac.yml
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Splits latest-mac.yml text into the lines before `files:`, the file entries, and the lines after. */
function split(text) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const start = lines.findIndex(line => line === 'files:');
  if (start === -1) throw new Error('no files: list');
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end++;
  return { head: lines.slice(0, start + 1), files: lines.slice(start + 1, end), tail: lines.slice(end) };
}

function field(text, name) {
  return text.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim();
}

/** Returns the merged latest-mac.yml. Both inputs must be for the same version. */
export function mergeMacYml(first, second) {
  const a = split(first);
  const b = split(second);
  if (field(first, 'version') !== field(second, 'version')) {
    throw new Error(`version mismatch: ${field(first, 'version')} vs ${field(second, 'version')}`);
  }
  const urls = new Set(a.files.filter(line => /^\s*- url: /.test(line)).map(line => line.trim()));
  const extra = [];
  for (let i = 0; i < b.files.length; i++) {
    if (!/^\s*- url: /.test(b.files[i])) continue;
    let j = i + 1;
    while (j < b.files.length && !/^\s*- url: /.test(b.files[j])) j++;
    if (!urls.has(b.files[i].trim())) extra.push(...b.files.slice(i, j));
    i = j - 1;
  }
  return [...a.head, ...a.files, ...extra, ...a.tail].join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, second] = process.argv.slice(2);
  if (!first || !second) {
    console.error('usage: merge-mac-yml.mjs <latest-mac.yml> <latest-mac.yml>');
    process.exit(1);
  }
  process.stdout.write(mergeMacYml(readFileSync(first, 'utf8'), readFileSync(second, 'utf8')));
}
