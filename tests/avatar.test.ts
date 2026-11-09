import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLook, AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES, avatarMood, cleanLook, freshLook, isLook, lookFromId, SUPER_LOOK } from '../shared/avatar.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir } from './helpers.ts';

test('a look comes from the id: the same every time, always in the palette, and varied', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}-${(i * 7919).toString(36)}`);
  for (const id of ids) {
    const look = lookFromId(id);
    assert.deepEqual(lookFromId(id), look, 'stable across calls (and restarts: it is only a hash)');
    assert.ok(isLook(look));
  }
  const shapes = new Set(ids.map(id => lookFromId(id).shape));
  const colors = new Set(ids.map(id => lookFromId(id).color));
  const eyes = new Set(ids.map(id => lookFromId(id).eyes));
  assert.equal(shapes.size, AVATAR_SHAPES.length, 'every shape turns up');
  assert.equal(colors.size, AVATAR_COLORS.length, 'every colour turns up');
  assert.equal(eyes.size, AVATAR_EYES.length);
  assert.equal(AVATAR_SHAPES.length, 8);
  assert.equal(AVATAR_COLORS.length, 10);
});

test('stored looks are validated and cleaned; the SuperAgent always looks like itself', () => {
  assert.deepEqual(cleanLook({ shape: 'blob', color: 'teal', eyes: 'tall', extra: 1 }), { shape: 'blob', color: 'teal', eyes: 'tall' });
  assert.equal(cleanLook({ shape: 'star', color: 'teal', eyes: 'tall' }), null);
  assert.equal(cleanLook({ shape: 'blob', color: '#fff', eyes: 'tall' }), null);
  assert.equal(cleanLook('blob'), null);
  assert.deepEqual(agentLook({ id: 'x', role: 'super', avatar: { shape: 'circle', color: 'teal', eyes: 'round' } }), SUPER_LOOK);
  assert.deepEqual(agentLook({ id: 'x', avatar: { shape: 'circle', color: 'teal', eyes: 'round' } }), { shape: 'circle', color: 'teal', eyes: 'round' });
  assert.deepEqual(agentLook({ id: 'x', avatar: { shape: 'nope' } }), lookFromId('x'), 'a bad stored look falls back to the id');
});

test('a new agent gets a shape and colour no one else has while any is free', () => {
  const taken = AVATAR_SHAPES.flatMap(shape => AVATAR_COLORS.map(color => ({ shape, color, eyes: 'round' as const })))
    .filter(l => !(l.shape === 'pebble' && l.color === 'green'));
  const look = freshLook(taken, () => 0.5);
  assert.equal(`${look.shape}:${look.color}`, 'pebble:green', 'the only free pair');
  assert.notEqual(`${freshLook([], () => 0).shape}:${freshLook([], () => 0).color}`, `${SUPER_LOOK.shape}:${SUPER_LOOK.color}`, 'never the SuperAgent\'s');
  assert.ok(isLook(freshLook([...taken, { shape: 'pebble', color: 'green', eyes: 'round' }], () => 0.99)), 'all taken: still a valid look');
});

test('status maps to the face: content, lively, attentive, pleased or tired', () => {
  assert.equal(avatarMood('idle'), 'calm');
  assert.equal(avatarMood('done'), 'pleased');
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
  const updated = await h.manager.update(ada.id, { avatar: { shape: 'diamond', color: 'coral', eyes: 'wide' } });
  assert.deepEqual(updated.avatar, { shape: 'diamond', color: 'coral', eyes: 'wide' });
  await assert.rejects(h.manager.update(ada.id, { avatar: { shape: 'star', color: 'coral', eyes: 'wide' } as never }), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(h.manager.update(ada.id, { avatar: { ...SUPER_LOOK, eyes: 'round' } }), (e: unknown) => e instanceof HttpError && e.status === 400, 'no one else looks like the SuperAgent');
  const copycat = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: project.id, avatar: SUPER_LOOK });
  assert.ok(isLook(copycat.avatar) && !(copycat.avatar!.shape === SUPER_LOOK.shape && copycat.avatar!.color === SUPER_LOOK.color), 'a create asking for it gets a free look');
  const sup = await h.manager.createSuper();
  assert.equal(sup.avatar, undefined);
  await assert.rejects(h.manager.update(sup.id, { avatar: { shape: 'circle', color: 'teal', eyes: 'round' } }), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test('the gallery (every shape, colour, eye style and mood) matches tests/fixtures/avatar-gallery.svg', async () => {
  const { avatarGallery } = await import('../shared/avatar.ts');
  const fs = await import('node:fs');
  const file = new URL('./fixtures/avatar-gallery.svg', import.meta.url);
  const svg = avatarGallery();
  // Regenerate on purpose with UPDATE_AVATAR_GALLERY=1; otherwise a change to the set must be seen.
  if (process.env.UPDATE_AVATAR_GALLERY === '1' || !fs.existsSync(file)) fs.writeFileSync(file, svg);
  assert.equal(svg, fs.readFileSync(file, 'utf8'));
  assert.equal(svg.match(/<path d="M[^"]*" fill="#/g)?.length, 2 * (8 * (5 + 3) + 10 + 5 * 2), 'both panels: every shape at 5 sizes and 3 eye styles, 10 colours, 5 moods at 40 and 16 px');
});

test('a face is cheerful and stays legible small: catchlights, smile and blush only from 18px', async () => {
  const { avatarParts, isSmallAvatar, AVATAR_EYE_Y, AVATAR_PATH } = await import('../shared/avatar.ts');
  const kinds = (parts: { kind: string }[]) => parts.map(p => p.kind);
  const round = { shape: 'circle', color: 'teal', eyes: 'round' } as const;
  assert.deepEqual(kinds(avatarParts(round, 'calm', false)), ['body', 'eye', 'eye', 'glint', 'glint', 'smile']);
  assert.deepEqual(kinds(avatarParts({ ...round, eyes: 'wide' }, 'calm', false)), ['body', 'blush', 'blush', 'eye', 'eye', 'glint', 'glint']);
  assert.deepEqual(kinds(avatarParts(round, 'calm', true)), ['body', 'eye', 'eye'], 'small keeps only what survives at 14 to 16px');
  const big = avatarParts(round, 'calm', false).find(p => p.kind === 'eye') as { rx: number };
  const small = avatarParts(round, 'calm', true).find(p => p.kind === 'eye') as { rx: number };
  assert.ok(small.rx > big.rx, 'small faces get bigger eyes');
  assert.deepEqual(kinds(avatarParts(round, 'pleased', false)), ['body', 'happy', 'happy', 'smile'], 'pleased closes into happy arcs');
  assert.deepEqual(kinds(avatarParts(round, 'pleased', true)), ['body', 'eye', 'eye'], 'too small for arcs: plain eyes');
  assert.ok(!kinds(avatarParts(round, 'down', false)).some(k => k === 'smile' || k === 'glint' || k === 'blush'), 'tired, not smiling');
  for (const y of Object.values(AVATAR_EYE_Y)) assert.ok(y < 19, 'eyes sit in the upper half of the face');
  assert.equal(Object.keys(AVATAR_PATH).length, 8);
  assert.equal(isSmallAvatar(16), true);
  assert.equal(isSmallAvatar(18), false);
});
