import assert from 'node:assert/strict';
import test from 'node:test';
import { cksum } from '../server/cksum.ts';

// Expected values are what /usr/bin/cksum printed (macOS, 2026-11-15) for the same bytes on stdin,
// e.g. `printf 'a' | /usr/bin/cksum`; the test never runs cksum itself (ACH-51).
const LINE = 'PodCode push guard: a line of the pre-push hook.\n';
const UNICODE = 'pré-push — \u{1F512} hook\n';
const binary = () => {
  const bytes = new Uint8Array(70000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  return bytes;
};

test('cksum matches POSIX cksum byte for byte: "<crc> <length>" (ACH-51)', () => {
  assert.equal(cksum(''), '4294967295 0', 'empty');
  assert.equal(cksum('a'), '1220704766 1');
  assert.equal(cksum('abc'), '1219131554 3');
  assert.equal(cksum('123456789'), '930766865 9', 'the CRC catalogue check string');
  assert.equal(cksum(LINE.repeat(160)), '1885696400 7840', 'a multi-KB text');
  assert.equal(cksum(UNICODE.repeat(300)), '1686840354 7200', 'a string is hashed as its UTF-8 bytes');
  assert.equal(cksum(binary()), '927589609 70000', 'bytes, with a length that takes three bytes');
});

test('the push guard no longer runs cksum to hash its hook', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../server/pushGuard.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /spawnSync|spawn\(\s*'cksum'|execFile(?:Sync)?\(\s*'cksum'/, 'no cksum child process on the server');
});
