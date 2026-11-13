import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { Project, TerminalInfo } from '../shared/types.ts';
import { createServer } from '../server/app.ts';
import { Hub } from '../server/hub.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { shellEnv, Terminals } from '../server/terminals.ts';
import { projectDir, tempDir } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

// A plain shell keeps the tests quick and independent of the user's own rc files.
process.env.SHELL = '/bin/sh';

const ORIGIN = { Origin: 'http://localhost:5174' };

async function boot() {
  const dir = tempDir('term');
  const store = new Store(path.join(dir, 'data'));
  store.load();
  const hub = new Hub();
  const engine = { available: false, path: null, version: null };
  const manager = new AgentManager(store, hub, { claude: engine, codex: engine, orcacode: engine });
  manager.init();
  const terminals = new Terminals(id => manager.project(id));
  const server = createServer(manager, hub, { terminals, auth: OPEN_AUTH });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  const addProject = async (name: string) => {
    const folder = projectDir(dir, name);
    const { data } = await call('POST', '/api/projects', { path: folder });
    return { project: data as Project, folder };
  };
  const close = () => new Promise<void>(resolve => {
    terminals.closeAll();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { dir, port, terminals, call, addProject, close };
}

/** A terminal socket that gathers everything the shell prints. */
async function attach(port: number, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}`, { headers: ORIGIN });
  let output = '';
  const controls: unknown[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) output += Buffer.from(data as Buffer).toString('utf8');
    else controls.push(JSON.parse(String(data)));
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    controls,
    get output() { return output; },
    type: (text: string) => ws.send(Buffer.from(text, 'utf8'), { binary: true }),
    /** Resolves once the output matches, or fails after a few seconds. */
    waitFor: (pattern: RegExp) => new Promise<RegExpMatchArray>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}. Output so far:\n${output}`)), 8000);
      const check = () => {
        const match = output.match(pattern);
        if (match) { clearTimeout(timer); resolve(match); } else waiters.push(check);
      };
      check();
    }),
  };
}

test('a terminal starts a shell in its project folder, and replays its output to a page that attaches later', async () => {
  const app = await boot();
  try {
    const { project, folder } = await app.addProject('alpha');
    const created = await app.call('POST', '/api/terminals', { projectId: project.id, cols: 90, rows: 20 });
    assert.equal(created.status, 201);
    const info = created.data as TerminalInfo;
    assert.equal(info.projectId, project.id);
    assert.equal(info.cwd, folder);
    assert.equal(info.shell, 'sh');
    assert.deepEqual((await app.call('GET', '/api/terminals')).data, [info]);

    const first = await attach(app.port, info.id);
    first.type('echo "cwd=$(pwd -P)"\r');
    const [, cwd] = await first.waitFor(/cwd=(\/[^\r\n]*)\r?\n/);
    assert.equal(cwd, fs.realpathSync(folder));

    first.ws.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }));
    first.type('echo "size=$(stty size)"\r');
    await first.waitFor(/size=33 101/);
    first.ws.close();

    // A reloaded page attaches to the same shell and sees what it printed before.
    const second = await attach(app.port, info.id);
    await second.waitFor(/cwd=\//);
    second.type('echo "still=$((40 + 2))"\r');
    await second.waitFor(/still=42/);
    second.ws.close();
  } finally {
    await app.close();
  }
});

test('a shell that exits says so on its socket and leaves the list', async () => {
  const app = await boot();
  try {
    const { project } = await app.addProject('beta');
    const info = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const term = await attach(app.port, info.id);
    const closed = new Promise<number>(resolve => term.ws.once('close', code => resolve(code)));
    term.type('exit 3\r');
    assert.equal(await closed, 1000);
    assert.deepEqual(term.controls, [{ type: 'exit', exitCode: 3 }]);
    assert.deepEqual((await app.call('GET', '/api/terminals')).data, []);
  } finally {
    await app.close();
  }
});

test('closing a terminal or removing its project ends the shell', async () => {
  const app = await boot();
  try {
    const { project } = await app.addProject('gamma');
    const one = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const two = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const term = await attach(app.port, one.id);
    const closed = new Promise<void>(resolve => term.ws.once('close', () => resolve()));

    assert.equal((await app.call('DELETE', `/api/terminals/${one.id}`)).status, 204);
    await closed;
    assert.deepEqual(((await app.call('GET', '/api/terminals')).data as TerminalInfo[]).map(t => t.id), [two.id]);
    assert.equal((await app.call('DELETE', `/api/terminals/${one.id}`)).status, 404);

    assert.equal((await app.call('DELETE', `/api/projects/${project.id}`)).status, 204);
    assert.deepEqual((await app.call('GET', '/api/terminals')).data, []);
  } finally {
    await app.close();
  }
});

test('terminals refuse unknown projects, missing folders and foreign pages', async () => {
  const app = await boot();
  try {
    assert.equal((await app.call('POST', '/api/terminals', { projectId: 'nope' })).status, 404);

    const { project, folder } = await app.addProject('delta');
    fs.rmSync(folder, { recursive: true });
    const missing = await app.call('POST', '/api/terminals', { projectId: project.id });
    assert.equal(missing.status, 409);
    assert.match((missing.data as { error: string }).error, /folder is missing/);
    fs.mkdirSync(folder);

    const info = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const refused = async (url: string, headers: Record<string, string>) => {
      const ws = new WebSocket(url, { headers });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => reject(new Error(`${url} opened for ${JSON.stringify(headers)}`)));
        ws.once('error', () => resolve());
      });
    };
    await refused(`ws://127.0.0.1:${app.port}/ws/terminal/${info.id}`, { Origin: 'https://evil.example' });
    await refused(`ws://127.0.0.1:${app.port}/ws/terminal/${info.id}`, { Host: 'evil.example', ...ORIGIN });

    // An unknown id opens, then closes with 4404, so the page can tell it apart from a dropped line.
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/terminal/term_000000000000`, { headers: ORIGIN });
    const code = await new Promise<number>(resolve => ws.once('close', c => resolve(c)));
    assert.equal(code, 4404);
  } finally {
    await app.close();
  }
});

test('the event feed lists terminals on connect and when they change', async () => {
  const app = await boot();
  try {
    const { project } = await app.addProject('epsilon');
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: ORIGIN });
    const events: { type: string; terminals?: TerminalInfo[] }[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', data => {
      events.push(JSON.parse(String(data)));
      for (const wake of waiters.splice(0)) wake();
    });
    const nextTerminals = (count: number) => new Promise<TerminalInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No terminals event.')), 3000);
      const check = () => {
        const found = events.filter(e => e.type === 'terminals');
        if (found.length >= count) { clearTimeout(timer); resolve(found[count - 1].terminals!); } else waiters.push(check);
      };
      check();
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    assert.deepEqual(await nextTerminals(1), []);
    const info = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    assert.deepEqual(await nextTerminals(2), [info]);
    await app.call('DELETE', `/api/terminals/${info.id}`);
    assert.deepEqual(await nextTerminals(3), []);
    ws.close();
  } finally {
    await app.close();
  }
});

test('a split starts in the folder its source shell reported, and only within the same project', async () => {
  const app = await boot();
  try {
    const { project, folder } = await app.addProject('zeta');
    const other = await app.addProject('eta');
    const source = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const term = await attach(app.port, source.id);
    // Markers are typed split in two, so the echo of the typed line cannot match them.
    // What zsh does after each command: OSC 7 with the folder, URL-encoded, ended by ESC and a backslash.
    term.type(`mkdir -p "sub dir" && cd "sub dir" && printf '\\033]7;file://host%s\\033\\\\' "$(pwd | sed 's/ /%20/g')" && echo "rep""orted"\r`);
    await term.waitFor(/reported\r?\n/);

    const split = (await app.call('POST', '/api/terminals', { projectId: project.id, from: source.id })).data as TerminalInfo;
    assert.equal(split.cwd, path.join(folder, 'sub dir'));
    const splitTerm = await attach(app.port, split.id);
    splitTerm.type('echo "cwd=$(pwd -P)"\r');
    const [, cwd] = await splitTerm.waitFor(/cwd=(\/[^\r\n]*)\r?\n/);
    assert.equal(cwd, fs.realpathSync(path.join(folder, 'sub dir')));

    // BEL ends it too; a terminal from another project, or no source, starts at the project's root.
    term.type(`cd .. && printf '\\033]7;file://host%s\\007' "$PWD" && echo "ba""ck"\r`);
    await term.waitFor(/back\r?\n/);
    assert.equal(((await app.call('POST', '/api/terminals', { projectId: project.id, from: source.id })).data as TerminalInfo).cwd, folder);
    assert.equal(((await app.call('POST', '/api/terminals', { projectId: other.project.id, from: source.id })).data as TerminalInfo).cwd, other.folder);
    term.ws.close();
    splitTerm.ws.close();
  } finally {
    await app.close();
  }
});

test('the busy check names the program running in a terminal, and leaves idle shells out', async () => {
  const app = await boot();
  try {
    const { project } = await app.addProject('theta');
    const idle = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const working = (await app.call('POST', '/api/terminals', { projectId: project.id })).data as TerminalInfo;
    const term = await attach(app.port, working.id);
    term.type('echo started; sleep 30\r');
    await term.waitFor(/started\r?\n/);
    const ids = `${idle.id},${working.id},term_gone`;
    let busy: Record<string, string> = {};
    for (let i = 0; i < 40 && !busy[working.id]; i++) {
      busy = (await app.call('GET', `/api/terminals/busy?ids=${ids}`)).data as Record<string, string>;
      if (!busy[working.id]) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(busy, { [working.id]: 'sleep' });
    term.ws.close();
  } finally {
    await app.close();
  }
});

test('a new shell does not inherit the terminal PodCode was started from', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2', GHOSTTY_RESOURCES_DIR: '/x',
      TMUX: '/tmp/tmux', ELECTRON_RUN_AS_NODE: '1', npm_config_prefix: '/y', ITERM_SESSION_ID: 'z', HOME_KEEP: 'kept',
    });
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    const env = shellEnv('/work/here');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.COLORTERM, 'truecolor');
    assert.equal(env.TERM_PROGRAM, 'PodCode');
    assert.equal(env.PWD, '/work/here');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.equal(env.HOME_KEEP, 'kept');
    for (const gone of ['TERM_PROGRAM_VERSION', 'GHOSTTY_RESOURCES_DIR', 'TMUX', 'ELECTRON_RUN_AS_NODE', 'npm_config_prefix', 'ITERM_SESSION_ID']) {
      assert.equal(env[gone], undefined, gone);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
