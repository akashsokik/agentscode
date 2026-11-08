import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalOrigin } from '../server/app.ts';

const ports = [4320, 5174];

test('only AgentsCode\'s own pages may write or open sockets', () => {
  // No Origin: same-origin navigations and non-browser clients.
  assert.equal(isLocalOrigin(undefined, ports), true);
  for (const origin of ['http://127.0.0.1:4320', 'http://localhost:4320', 'http://[::1]:4320', 'http://localhost:5174']) {
    assert.equal(isLocalOrigin(origin, ports), true, origin);
  }
  for (const origin of [
    'http://localhost:3000', // a dev server, in the user's browser or AgentsCode's browser tab
    'http://127.0.0.1:8080',
    'http://localhost', // port 80
    'https://localhost:4320', // the app is never served over https
    'https://evil.example',
    'http://evil.example:4320',
    'null',
    'file://',
  ]) {
    assert.equal(isLocalOrigin(origin, ports), false, origin);
  }
});

test('inside the desktop app only the server\'s own port counts', () => {
  assert.equal(isLocalOrigin('http://127.0.0.1:4320', [4320]), true);
  assert.equal(isLocalOrigin('http://localhost:5174', [4320]), false);
});
