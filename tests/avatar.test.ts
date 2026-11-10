import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SHAPES, agentLook, assignLooks, AVATAR_COLORS, AVATAR_EYE_AT, AVATAR_EYES, AVATAR_FILL, AVATAR_PATH, AVATAR_PILL, AVATAR_SHAPE_NAMES, AVATAR_SHAPES, AVATAR_TILT,
  avatarEyeTurn, avatarGallery, avatarMarkup, avatarMood, avatarParts, cleanLook, freshLook, isLook, isSmallAvatar, isSuperPair, LEGACY_SHAPES, lookFromId, migrateLooks, SUPER_LOOK,
  type AvatarLook, type AvatarShape,
} from '../shared/avatar.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir } from './helpers.ts';

test('the set: twelve shapes (eleven for agents, the Cloud for the SuperAgent) and twelve colours', () => {
  assert.equal(AVATAR_SHAPES.length, 12);
  assert.equal(AGENT_SHAPES.length, 11);
  assert.ok(!AGENT_SHAPES.includes('cloud'), 'agents are never given the Cloud');
  assert.deepEqual(SUPER_LOOK, { shape: 'cloud', color: 'violet', eyes: 'round' });
  assert.equal(AVATAR_COLORS.length, 12);
  assert.ok(AVATAR_COLORS.includes('olive') && AVATAR_COLORS.includes('plum'));
  for (const shape of AVATAR_SHAPES) {
    assert.ok(AVATAR_PATH[shape] && AVATAR_SHAPE_NAMES[shape] && AVATAR_EYE_AT[shape] && Number.isFinite(AVATAR_TILT[shape]), shape);
  }
  assert.equal(new Set(Object.values(AVATAR_PATH)).size, 12, 'every shape has its own outline');
  assert.equal(new Set(Object.values(AVATAR_FILL)).size, 12, 'every colour is its own');
});

test('a look comes from the id when none is stored: the same every time, valid, varied, never the Cloud', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `agent-${i}-${(i * 7919).toString(36)}`);
  for (const id of ids) {
    const look = lookFromId(id);
    assert.deepEqual(lookFromId(id), look, 'stable across calls (and restarts: it is only a hash)');
    assert.ok(isLook(look));
    assert.notEqual(look.shape, 'cloud');
  }
  assert.equal(new Set(ids.map(id => lookFromId(id).shape)).size, AGENT_SHAPES.length, 'every agent shape turns up');
  assert.equal(new Set(ids.map(id => lookFromId(id).color)).size, AVATAR_COLORS.length, 'every colour turns up');
  assert.equal(new Set(ids.map(id => lookFromId(id).eyes)).size, AVATAR_EYES.length);
  // The fallback: no stored look, or one that cannot be read, is the look from the id.
  assert.deepEqual(agentLook({ id: 'x' }), lookFromId('x'));
  assert.deepEqual(agentLook({ id: 'x', avatar: { shape: 'nope' } }), lookFromId('x'));
  assert.deepEqual(agentLook({ id: 'x', avatar: null }), lookFromId('x'));
});

test('stored looks are validated and cleaned; the SuperAgent always looks like itself', () => {
  assert.deepEqual(cleanLook({ shape: 'kite', color: 'teal', eyes: 'tall', extra: 1 }), { shape: 'kite', color: 'teal', eyes: 'tall' });
  assert.equal(cleanLook({ shape: 'star', color: 'teal', eyes: 'tall' }), null);
  assert.equal(cleanLook({ shape: 'kite', color: '#fff', eyes: 'tall' }), null);
  assert.equal(cleanLook({ shape: 'kite', color: 'teal', eyes: 'crossed' }), null);
  assert.equal(cleanLook({ shape: 'constructor', color: 'teal', eyes: 'tall' }), null, 'only the listed old names are mapped');
  assert.equal(cleanLook('kite'), null);
  assert.equal(cleanLook(null), null);
  assert.deepEqual(agentLook({ id: 'x', role: 'super', avatar: { shape: 'disc', color: 'teal', eyes: 'round' } }), SUPER_LOOK);
  assert.deepEqual(agentLook({ id: 'x', avatar: { shape: 'disc', color: 'teal', eyes: 'round' } }), { shape: 'disc', color: 'teal', eyes: 'round' });
});

test('a look stored under a first-set shape name moves to the nearest new shape, colour and eyes kept', () => {
  const expected: Record<string, AvatarShape> = { circle: 'disc', squircle: 'tile', triangle: 'dome', pebble: 'bean', capsule: 'arch', pentagon: 'pentagon', blob: 'cloud', diamond: 'almond' };
  assert.deepEqual({ ...LEGACY_SHAPES }, expected, 'Bun, Lumpy square, Gumdrop, Pebble, Bulb, Clover, Cloud, Leaf');
  for (const [old, shape] of Object.entries(expected)) {
    for (const color of ['teal', 'slate', 'coral'] as const) {
      assert.deepEqual(cleanLook({ shape: old, color, eyes: 'wide' }), { shape, color, eyes: 'wide' }, `${old} in ${color}`);
      assert.deepEqual(agentLook({ id: 'a', avatar: { shape: old, color, eyes: 'tall' } }), { shape, color, eyes: 'tall' }, 'drawn right even before it is rewritten');
    }
  }
  // Only looks that read differently are rewritten; the rest, and agents with none, are left alone.
  const moved = migrateLooks([
    { id: 'old', avatar: { shape: 'pebble', color: 'green', eyes: 'round' } },
    { id: 'new', avatar: { shape: 'kite', color: 'plum', eyes: 'round' } },
    { id: 'none' },
    { id: 'broken', avatar: { shape: 'star', color: 'green', eyes: 'round' } },
    { id: 'extra', avatar: { shape: 'circle', color: 'rose', eyes: 'tall', junk: true } },
  ]);
  assert.deepEqual([...moved], [['old', { shape: 'bean', color: 'green', eyes: 'round' }], ['extra', { shape: 'disc', color: 'rose', eyes: 'tall' }]]);
});

test('a new agent gets a shape and colour no one else has while any is free', () => {
  const taken = AGENT_SHAPES.flatMap(shape => AVATAR_COLORS.map(color => ({ shape, color, eyes: 'round' as const })))
    .filter(l => !(l.shape === 'bean' && l.color === 'green'));
  const look = freshLook(taken, () => 0.5);
  assert.equal(`${look.shape}:${look.color}`, 'bean:green', 'the only free pair');
  const all: AvatarLook[] = [...taken, { shape: 'bean', color: 'green', eyes: 'round' }];
  for (const r of [0, 0.3, 0.6, 0.85, 0.99]) {
    const full = freshLook(all, () => r);
    assert.ok(isLook(full), 'all taken: still a valid look');
    assert.notEqual(full.shape, 'cloud', 'never the Cloud, even when every pair is taken');
    assert.notEqual(freshLook([], () => r).shape, 'cloud');
  }
});

test('a team built one agent at a time never repeats a pair, and spreads colours then shapes', () => {
  let n = 0;
  const random = () => ((n++ * 0.6180339887) % 1);
  const team: AvatarLook[] = [];
  for (let i = 0; i < AGENT_SHAPES.length * AVATAR_COLORS.length; i++) team.push(freshLook(team, random));
  const pairs = new Set(team.map(l => `${l.shape}:${l.color}`));
  assert.equal(pairs.size, 132, 'all 11 x 12 pairs are used before any repeats');
  assert.ok(team.every(l => l.shape !== 'cloud' && !isSuperPair(l)));
  // The first twelve agents each get their own colour, the first eleven their own shape.
  assert.equal(new Set(team.slice(0, 12).map(l => l.color)).size, 12, 'fewest-used colour first');
  assert.equal(new Set(team.slice(0, 11).map(l => l.shape)).size, 11, 'then fewest-used shape');
  // The 133rd agent still gets a valid look.
  assert.ok(isLook(freshLook(team, random)));
});

test('status maps to the face: calm, lively, attentive or tired; a finished agent is simply calm', () => {
  assert.equal(avatarMood('idle'), 'calm');
  assert.equal(avatarMood('done'), 'calm');
  assert.equal(avatarMood('working'), 'busy');
  assert.equal(avatarMood('waiting'), 'waiting');
  assert.equal(avatarMood('error'), 'down');
  assert.equal(avatarMood(undefined), 'calm');
});

test('agents get a look when made; a change is validated, and the SuperAgent keeps its own', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: project.id });
  assert.ok(isLook(ada.avatar) && isLook(bo.avatar));
  assert.notEqual(`${ada.avatar!.shape}:${ada.avatar!.color}`, `${bo.avatar!.shape}:${bo.avatar!.color}`);
  const updated = await h.manager.update(ada.id, { avatar: { shape: 'almond', color: 'coral', eyes: 'wide' } });
  assert.deepEqual(updated.avatar, { shape: 'almond', color: 'coral', eyes: 'wide' });
  // A client from before this set still sends the old names: stored under the new one.
  const legacy = await h.manager.update(ada.id, { avatar: { shape: 'diamond', color: 'plum', eyes: 'wide' } as never });
  assert.deepEqual(legacy.avatar, { shape: 'almond', color: 'plum', eyes: 'wide' });
  await assert.rejects(h.manager.update(ada.id, { avatar: { shape: 'star', color: 'coral', eyes: 'wide' } as never }), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(h.manager.update(ada.id, { avatar: { ...SUPER_LOOK, eyes: 'round' } }), (e: unknown) => e instanceof HttpError && e.status === 400, 'no one else looks like the SuperAgent');
  await assert.rejects(h.manager.update(ada.id, { avatar: { shape: 'blob', color: 'violet', eyes: 'round' } as never }), (e: unknown) => e instanceof HttpError && e.status === 400, 'nor by its old name');
  const copycat = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: project.id, avatar: SUPER_LOOK });
  assert.ok(isLook(copycat.avatar) && !isSuperPair(copycat.avatar!), 'a create asking for it gets a free look');
  const sup = await h.manager.createSuper();
  assert.equal(sup.avatar, undefined);
  await assert.rejects(h.manager.update(sup.id, { avatar: { shape: 'disc', color: 'teal', eyes: 'round' } }), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test('data saved by an older version loads: old shape names move over, colours stay, nothing is reassigned', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: project.id });
  const cy = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: project.id });
  // What the first set left on disk, plus an agent from before avatars and one with a look that cannot be read.
  (h.manager as unknown as { store: { agents: Map<string, { avatar?: unknown }> } }).store.agents.get(ada.id)!.avatar = { shape: 'pebble', color: 'green', eyes: 'tall' };
  (h.manager as unknown as { store: { agents: Map<string, { avatar?: unknown }> } }).store.agents.get(bo.id)!.avatar = { shape: 'blob', color: 'teal', eyes: 'round' };
  delete (h.manager as unknown as { store: { agents: Map<string, { avatar?: unknown }> } }).store.agents.get(cy.id)!.avatar;
  assert.doesNotThrow(() => h.manager.init());
  const after = (id: string) => h.manager.snapshot().agents.find(a => a.id === id)!.avatar;
  assert.deepEqual(after(ada.id), { shape: 'bean', color: 'green', eyes: 'tall' });
  assert.deepEqual(after(bo.id), { shape: 'cloud', color: 'teal', eyes: 'round' }, 'an old Cloud stays a Cloud in its own colour');
  assert.ok(isLook(after(cy.id)), 'an agent from before avatars gets a look');
  assert.notEqual(after(cy.id)!.shape, 'cloud');
  assert.notEqual(`${after(cy.id)!.shape}:${after(cy.id)!.color}`, 'bean:green', 'and not one a migrated agent has');
});

test('agents from before avatars get distinct looks once, colours spread out; migrated looks count as taken', () => {
  const agents = [
    { id: 'super', role: 'super' },
    { id: 'kept', role: 'dev', avatar: { shape: 'disc', color: 'orange', eyes: 'round' } },
    { id: 'old', role: 'dev', avatar: { shape: 'pebble', color: 'teal', eyes: 'round' } },
    { id: 'fen', role: 'dev' }, { id: 'rhea', role: 'reviewer' }, { id: 'bo', role: 'dev' },
  ];
  let n = 0;
  const looks = assignLooks(agents, () => ((n++ * 0.37) % 1));
  assert.deepEqual([...looks.keys()], ['fen', 'rhea', 'bo'], 'the SuperAgent and agents with a look, old name or new, are left alone');
  assert.ok([...looks.values()].every(isLook));
  assert.equal(new Set([...[...looks.values()].map(l => l.color), 'orange', 'teal']).size, 5, 'five agents, five colours');
});

// ---- drawing ----

/** The outline as a polygon: the path's M, L, C and Z commands, curves flattened. */
function outline(d: string): [number, number][] {
  const points: [number, number][] = [];
  let at: [number, number] = [0, 0];
  for (const [, command, args] of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === 'M' || command === 'L') { at = [n[0], n[1]]; points.push(at); }
    if (command === 'C') {
      const [x1, y1, x2, y2, x, y] = n;
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        points.push([u * u * u * at[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * at[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]);
      }
      at = [x, y];
    }
  }
  return points;
}

function inside(polygon: [number, number][], [px, py]: [number, number]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

test('a face is flat: one solid body and two pill eyes, no shading, strokes or mouth, bigger pills when small', () => {
  const kinds = (parts: { kind: string }[]) => parts.map(p => p.kind);
  const look = { shape: 'disc', color: 'teal', eyes: 'round' } as const;
  for (const eyes of AVATAR_EYES) for (const mood of ['calm', 'busy', 'waiting', 'down'] as const) {
    assert.deepEqual(kinds(avatarParts({ ...look, eyes }, mood, false)), ['body', 'eye', 'eye'], 'every mood keeps the pills; none draws anything else');
  }
  const body = avatarParts(look, 'calm', false)[0] as { fill: string };
  assert.equal(body.fill, AVATAR_FILL.teal, 'one solid colour');
  const eye = avatarParts(look, 'calm', false)[1] as { w: number; h: number };
  assert.ok(eye.h > eye.w * 2, 'tall narrow pills');
  assert.equal(eye.w, AVATAR_PILL.w);
  const small = avatarParts(look, 'calm', true)[1] as { w: number; h: number };
  assert.ok(small.h >= eye.h * 1.3 && small.w >= eye.w * 1.3, 'bigger pills at 14 to 16px');
  assert.equal(isSmallAvatar(16), true);
  assert.equal(isSmallAvatar(18), false);
  for (const shape of AVATAR_SHAPES) for (const size of [16, 40]) {
    const svg = avatarMarkup({ shape, color: 'plum', eyes: 'round' }, 'calm', size, { still: true });
    assert.doesNotMatch(svg, /Gradient|filter|opacity|stroke|shadow/i, 'no gradients, strokes, shadows or highlights');
    assert.equal(svg.match(/<path /g)?.length, 1, 'one body');
    assert.equal(svg.match(/<rect /g)?.length, 2, 'two eyes');
    assert.equal(svg.match(/fill="#[0-9a-f]{6}"/g)?.length, 3, 'one fill for the body, the ink for each eye');
  }
  assert.match(avatarMarkup(look, 'down', 40, { still: true }), /height="1\.79"/, 'tired pills flatten to dashes in a still frame (6.4 x 0.28)');
  for (const d of Object.values(AVATAR_PATH)) assert.match(d, /^M[\d. ]+(?:[CL][\d. -]+)+Z$/, 'plain move, line and curve commands on the 32 grid');
});

test('every body fills its 32 box without leaving it, and the eyes turn with the body', () => {
  for (const shape of AVATAR_SHAPES) {
    const points = outline(AVATAR_PATH[shape]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    assert.ok(Math.min(...xs) >= 0.5 && Math.max(...xs) <= 31.5 && Math.min(...ys) >= 0.5 && Math.max(...ys) <= 31.5, `${shape} stays inside the box`);
    assert.ok(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= 24, `${shape} is big enough to read at 16px`);
    const turn = avatarEyeTurn({ shape, color: 'teal', eyes: 'round' });
    assert.equal(turn.deg, AVATAR_TILT[shape] + 8);
    assert.deepEqual([turn.x, turn.y], [AVATAR_EYE_AT[shape].x, AVATAR_EYE_AT[shape].y]);
  }
});

test('the eyes sit inside the body for every shape, gaze and size', () => {
  for (const shape of AVATAR_SHAPES) {
    const polygon = outline(AVATAR_PATH[shape]);
    for (const eyes of AVATAR_EYES) for (const small of [false, true]) {
      const look = { shape, color: 'teal', eyes } as const;
      const turn = avatarEyeTurn(look);
      const a = (turn.deg * Math.PI) / 180;
      for (const part of avatarParts(look, 'calm', small)) {
        if (part.kind !== 'eye') continue;
        // The pill's four corners and its two ends, turned as the app turns them.
        const corners: [number, number][] = [[part.x, part.y], [part.x + part.w, part.y], [part.x, part.y + part.h], [part.x + part.w, part.y + part.h], [part.x + part.w / 2, part.y], [part.x + part.w / 2, part.y + part.h]];
        for (const [x, y] of corners) {
          const dx = x - turn.x, dy = y - turn.y;
          const point: [number, number] = [turn.x + dx * Math.cos(a) - dy * Math.sin(a), turn.y + dx * Math.sin(a) + dy * Math.cos(a)];
          assert.ok(inside(polygon, point), `${shape}, eyes ${eyes}, ${small ? 'small' : 'large'}: an eye leaves the body at ${point.map(v => v.toFixed(1))}`);
        }
      }
    }
  }
});

test('the gallery (every shape, colour, eye style and mood) matches tests/fixtures/avatar-gallery.svg', async () => {
  const fs = await import('node:fs');
  const file = new URL('./fixtures/avatar-gallery.svg', import.meta.url);
  const svg = avatarGallery();
  // Regenerate on purpose with UPDATE_AVATAR_GALLERY=1; otherwise a change to the set must be seen.
  if (process.env.UPDATE_AVATAR_GALLERY === '1' || !fs.existsSync(file)) fs.writeFileSync(file, svg);
  assert.equal(svg, fs.readFileSync(file, 'utf8'));
  assert.equal(svg.match(/<path d="M[^"]*" fill="#/g)?.length, 2 * (12 * (6 + 3) + 12 + 4 * 2), 'both panels: every shape at 6 sizes and 3 eye styles, 12 colours, 4 moods at 40 and 16 px');
});
