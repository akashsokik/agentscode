import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AVATAR_LEAD_INK, avatarParts, SUPER_LOOK, type AvatarLook } from '../shared/avatar.ts';
import { inkParts, parseAvatarStyle } from '../web/avatarStylePreference.ts';

// Appearance > Avatars: Colour or Ink (ACH-46, ACH-D62).

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
  assert.deepEqual(inkParts(avatarParts(SUPER_LOOK, 'calm', false)), avatarParts(SUPER_LOOK, 'calm', false), 'the SuperAgent is ink either way');
});

test('the switch sits in Appearance, kept like the theme; pickers keep colour; the Work graph keeps owner colours', () => {
  const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const settings = read('../web/dialogs/SettingsDialog.tsx');
  assert.match(settings, /<Segmented<AvatarStyle> label="Avatars" value=\{avatars\} onChange=\{setAvatarStyle\} options=\{\[\{ value: 'colour', label: 'Colour' \}, \{ value: 'ink', label: 'Ink' \}\]\}/);
  assert.match(read('../web/avatarStyle.ts'), /const KEY = 'podcode:avatars';/, 'stored in this browser, like the theme');
  const avatar = read('../web/ui/Avatar.tsx');
  assert.match(avatar, /const ink = useAvatarStyle\(\) === 'ink' && !colour;/);
  assert.match(avatar, /const parts = ink \? inkParts\(drawn\) : drawn;/);
  assert.match(read('../web/dialogs/AvatarPicker.tsx'), /<AvatarGlyph colour look=\{look\}/, 'where a colour is chosen, it shows');
  assert.match(read('../web/work/workPresentation.ts'), /AVATAR_FILL\[agentLook/, 'the Work graph still takes each owner\'s colour');
});
