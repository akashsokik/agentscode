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
  const all = [...taken, { shape: 'pebble', color: 'green', eyes: 'round' } as const];
  for (const r of [0, 0.3, 0.6, 0.85, 0.99]) {
    const look = freshLook(all, () => r);
    assert.ok(!(look.shape === SUPER_LOOK.shape && look.color === SUPER_LOOK.color), 'never the SuperAgent\'s, even when every pair is taken');
  }
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
  assert.equal(svg.match(/<path d="M[^"]*" fill="#/g)?.length, 2 * (8 * (6 + 3) + 10 + 5 * 2), 'both panels: every shape at 6 sizes and 3 eye styles, 10 colours, 5 moods at 40 and 16 px');
});

test('a face is flat: one solid body and two pill eyes, no shading or mouth, bigger pills when small', async () => {
  const { avatarParts, isSmallAvatar, AVATAR_PATH, AVATAR_FILL, AVATAR_PILL, avatarMarkup } = await import('../shared/avatar.ts');
  const kinds = (parts: { kind: string }[]) => parts.map(p => p.kind);
  const look = { shape: 'circle', color: 'teal', eyes: 'round' } as const;
  for (const eyes of ['round', 'tall', 'wide'] as const) {
    assert.deepEqual(kinds(avatarParts({ ...look, eyes }, 'calm', false)), ['body', 'eye', 'eye']);
  }
  const body = avatarParts(look, 'calm', false)[0] as { fill: string };
  assert.equal(body.fill, AVATAR_FILL.teal, 'one solid colour');
  const eye = avatarParts(look, 'calm', false)[1] as { w: number; h: number };
  assert.ok(eye.h > eye.w * 2, 'tall narrow pills');
  assert.equal(eye.w, AVATAR_PILL.w);
  const small = avatarParts(look, 'calm', true)[1] as { w: number; h: number };
  assert.ok(small.h >= eye.h * 1.3, 'bigger pills at 14 to 16px');
  assert.deepEqual(kinds(avatarParts(look, 'pleased', false)), ['body', 'happy', 'happy'], 'pleased pills become small arcs');
  const svg = avatarMarkup(look, 'down', 40, { still: true });
  assert.doesNotMatch(svg, /Gradient|opacity|stroke=".*" stroke-width="[^"]*"\/><\/g>.*smile/, 'no gradients or highlights');
  assert.match(svg, /height="1\.57"/, 'tired pills flatten to dashes in a still frame (5.6 x 0.28)');
  for (const d of Object.values(AVATAR_PATH)) assert.doesNotMatch(d, /[AaHhVv]/, 'organic curves, no arcs or straight edges');
  assert.equal(isSmallAvatar(16), true);
  assert.equal(isSmallAvatar(18), false);
});

test('agents from before avatars get distinct looks once, colours spread out', async () => {
  const { assignLooks, isLook } = await import('../shared/avatar.ts');
  const agents = [
    { id: 'super', role: 'super' },
    { id: 'kept', role: 'dev', avatar: { shape: 'circle', color: 'orange', eyes: 'round' } },
    { id: 'fen', role: 'dev' }, { id: 'rhea', role: 'reviewer' }, { id: 'bo', role: 'dev' },
  ];
  let n = 0;
  const looks = assignLooks(agents, () => ((n++ * 0.37) % 1));
  assert.deepEqual([...looks.keys()], ['fen', 'rhea', 'bo'], 'the SuperAgent and agents with a look are left alone');
  const colors = [...looks.values()].map(l => l.color);
  assert.ok([...looks.values()].every(isLook));
  assert.equal(new Set([...colors, 'orange']).size, 4, 'four agents, four colours');
});
