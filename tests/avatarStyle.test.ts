import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AVATAR_FILL, AVATAR_INK, AVATAR_LEAD_INK, avatarParts, SUPER_LOOK, type AvatarLook } from '../shared/avatar.ts';
import { colourParts, inkParts, parseAvatarStyle } from '../web/avatarStylePreference.ts';

// Appearance > Avatars: Colour or Ink, every avatar following it, the SuperAgent included (ACH-46, ACH-D64).

test('the stored choice: Colour by default and for anything unknown, Ink only when chosen', () => {
  assert.equal(parseAvatarStyle(null), 'colour');
  assert.equal(parseAvatarStyle(''), 'colour');
  assert.equal(parseAvatarStyle('Ink'), 'colour');
  assert.equal(parseAvatarStyle('ink'), 'ink');
  assert.equal(parseAvatarStyle('colour'), 'colour');
});

test('ink draws an agent the way the SuperAgent is drawn: only the fills change, shape, eyes and size stay', () => {
  const look: AvatarLook = { shape: 'bean', color: 'coral', eyes: 'round' };
  for (const small of [false, true]) {
    const colour = avatarParts(look, 'calm', small);
    const ink = inkParts(colour);
    assert.equal(ink.length, colour.length);
    ink.forEach((part, i) => {
      assert.deepEqual({ ...part, fill: '' }, { ...colour[i], fill: '' }, 'same path, same pills');
      assert.equal(part.fill, part.kind === 'body' ? AVATAR_LEAD_INK.body : AVATAR_LEAD_INK.eye);
    });
  }
});

test('the SuperAgent follows the switch too: its violet Block with dark pills in Colour, ink in Ink (ACH-D64)', () => {
  const drawn = avatarParts(SUPER_LOOK, 'calm', false);
  const colour = colourParts(SUPER_LOOK, drawn);
  assert.equal(colour[0].fill, AVATAR_FILL.violet, 'the colour it had before ACH-43');
  assert.equal(AVATAR_FILL.violet, '#8b5cd6');
  assert.ok(colour.slice(1).every(p => p.kind === 'eye' && p.fill === AVATAR_INK), 'the near-black pills every teammate has');
  assert.deepEqual(inkParts(drawn), drawn, 'Ink: the ink it has now');
  assert.equal(drawn[0].fill, AVATAR_LEAD_INK.body, 'drawn directly (the logo, tray and notification icons) it stays ink');
  const teammate: AvatarLook = { shape: 'bean', color: 'coral', eyes: 'round' };
  assert.deepEqual(colourParts(teammate, avatarParts(teammate, 'calm', true)), avatarParts(teammate, 'calm', true), 'a teammate in Colour is drawn as always');
});

test('the switch sits in Appearance, kept like the theme; pickers keep colour; the Work graph keeps owner colours', () => {
  const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const settings = read('../web/panes/SettingsPage.tsx');
  // Settings > Appearance (ACH-D82): a Select, as two or three options are on the Settings page.
  assert.match(settings, /<Choice<AvatarStyle> label="Avatars" value=\{avatars\} onChange=\{setAvatarStyle\} options=\{\[\{ value: 'colour', label: 'Colour' \}, \{ value: 'ink', label: 'Ink' \}\]\}/);
  assert.match(read('../web/avatarStyle.ts'), /const KEY = 'podcode:avatars';/, 'stored in this browser, like the theme');
  const avatar = read('../web/ui/Avatar.tsx');
  assert.match(avatar, /const ink = alwaysInk \|\| \(useAvatarStyle\(\) === 'ink' && !colour\);/);
  assert.match(read('../web/ui/BrandMark.tsx'), /<AvatarGlyph look=\{SUPER_LOOK\} ink /, 'the logo stays the ink Block in both modes');
  assert.match(avatar, /const parts = ink \? inkParts\(drawn\) : colourParts\(look, drawn\);/);
  assert.match(read('../web/dialogs/AvatarPicker.tsx'), /<AvatarGlyph colour look=\{look\}/, 'where a colour is chosen, it shows');
  assert.match(read('../web/work/workPresentation.ts'), /AVATAR_FILL\[agentLook/, 'the Work graph still takes each owner\'s colour');
});
