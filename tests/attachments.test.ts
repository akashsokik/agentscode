import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { Attachments, MAX_IMAGE_BYTES, sniffImage } from '../server/attachments.ts';
import { userContent } from '../server/agents/claude.ts';
import { codexArgs } from '../server/agents/codex.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    return error.status;
  }
  assert.fail('expected an error');
}

test('images are typed by their bytes, never by what the browser claimed', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.from('hello')), null);
});

test('saving checks the bytes and the size, and stores under a generated name', () => {
  const store = new Attachments(tempDir('attach'));
  const saved = store.save('a1', PNG, 'shot%20one.png');
  assert.match(saved.id, /^[0-9a-f-]{36}\.png$/);
  assert.equal(saved.name, 'shot one.png');
  assert.equal(saved.mediaType, 'image/png');
  assert.equal(store.file('a1', saved.id).size, PNG.length);
  assert.equal(status(() => store.save('a1', Buffer.alloc(0))), 400);
  assert.equal(status(() => store.save('a1', Buffer.from('<svg/>'))), 415);
  assert.equal(status(() => store.save('a1', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))), 413);
  // A path in the name is reduced to its last part.
  assert.equal(store.save('a1', JPEG, '../../etc/passwd').name, 'passwd');
});

test('an image is only reachable by its own agent and its generated name', () => {
  const store = new Attachments(tempDir('attach'));
  const saved = store.save('a1', PNG);
  assert.equal(status(() => store.file('a2', saved.id)), 404, "another agent's image");
  assert.equal(status(() => store.file('a1', `../a1/${saved.id}`)), 404);
  assert.equal(status(() => store.file('a1', 'notes.txt')), 404);
  const [resolved] = store.resolve('a1', [{ id: saved.id, name: 'mine.png' }]);
  assert.equal(resolved.attachment.name, 'mine.png');
  assert.ok(fs.existsSync(resolved.path));
  assert.equal(status(() => store.resolve('a2', [saved.id])), 400);
  assert.equal(status(() => store.resolve('a1', 'not a list')), 400);
  assert.equal(status(() => store.resolve('a1', Array(5).fill(saved.id))), 400, 'four images per message at most');
  assert.deepEqual(store.resolve('a1', undefined), []);
  store.remove('a1');
  assert.equal(status(() => store.file('a1', saved.id)), 404);
});

test('Claude gets images as blocks before the text, and no empty text block', () => {
  const dir = tempDir('attach');
  const file = path.join(dir, 'x.png');
  fs.writeFileSync(file, PNG);
  assert.equal(userContent('hi'), 'hi');
  const withText = userContent('What is this?', [{ path: file, mediaType: 'image/png' }]) as { type: string }[];
  assert.deepEqual(withText.map(b => b.type), ['image', 'text']);
  const alone = userContent('', [{ path: file, mediaType: 'image/png' }]) as { type: string }[];
  assert.deepEqual(alone.map(b => b.type), ['image']);
  const gone = userContent('hi', [{ path: path.join(dir, 'missing.png'), mediaType: 'image/png' }]) as { type: string; text?: string }[];
  assert.match(gone[0].text ?? '', /could not be read/);
});

test('Codex gets one --image=<file> each, before anything positional', () => {
  const agent = { autonomy: 'edits', sessionId: 'thread-1', model: '', effort: '', worktree: null } as unknown as Agent;
  const args = codexArgs(agent, undefined, [{ path: '/tmp/a.png', mediaType: 'image/png' }, { path: '/tmp/b.jpg', mediaType: 'image/jpeg' }]);
  assert.deepEqual(args.slice(0, 5), ['exec', 'resume', '--json', '--image=/tmp/a.png', '--image=/tmp/b.jpg']);
  assert.ok(args[5].startsWith('--'), 'another flag follows the images');
  assert.deepEqual(args.slice(-2), ['thread-1', '-']);
});

test('a message can be images alone; the engine still gets a line of text', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  assert.equal(status(() => h.manager.send(ada.id, '  ')), 400);
  const image = h.manager.saveAttachment(ada.id, PNG, 'screen.png');
  h.manager.send(ada.id, '', [{ id: image.id, name: image.name }]);
  await settle();
  const sent = h.runner(ada.id).sent[0];
  assert.match(sent.text, /sent an image/);
  assert.equal(sent.images?.length, 1);
  assert.equal(sent.images?.[0].mediaType, 'image/png');
  assert.equal(sent.task?.summary, 'Sent an image');
  const entry = h.manager.entries(ada.id).find(e => e.kind === 'user');
  assert.equal(entry?.text, '');
  assert.deepEqual(entry?.images?.map(i => i.name), ['screen.png']);
  const file = h.manager.attachmentFile(ada.id, image.id);
  assert.ok(fs.existsSync(file.path));
  await h.manager.remove(ada.id);
  assert.ok(!fs.existsSync(file.path), 'removing the agent deletes its images');
});

test('a channel post can carry images: each mentioned agent gets its own copy, and they go with the channel', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'codex', projectId: project.id });
  const channel = h.manager.createChannel({ name: 'design', memberIds: [ada.id, bo.id] });
  assert.equal(status(() => h.manager.postToChannel(channel.id, '  ', [ada.id])), 400);

  // Images uploaded to one channel cannot be posted in another, or named by an agent's id.
  const image = h.manager.saveChannelAttachment(channel.id, PNG, 'mock.png');
  const other = h.manager.createChannel({ name: 'other', memberIds: [ada.id] });
  assert.equal(status(() => h.manager.postToChannel(other.id, 'look', [], undefined, [{ id: image.id }])), 400);
  assert.equal(status(() => h.manager.attachmentFile(ada.id, image.id)), 404);

  // Images alone are a post; the prompt still has a line of text and says what came with it.
  const post = h.manager.postToChannel(channel.id, '', [ada.id, bo.id], undefined, [{ id: image.id, name: image.name }]);
  await settle();
  assert.deepEqual(post.images?.map(i => i.name), ['mock.png']);
  assert.deepEqual(h.manager.channelPosts(channel.id).find(p => p.id === post.id)?.images?.map(i => i.id), [image.id]);
  for (const agent of [ada, bo]) {
    const sent = h.runner(agent.id).sent[0];
    assert.match(sent.text, /posted an image with no text/);
    assert.match(sent.text, /image is attached to this message/);
    assert.equal(sent.task?.summary, 'Posted an image');
    assert.equal(sent.images?.length, 1);
    assert.equal(sent.images?.[0].mediaType, 'image/png');
    // The copy lives with the agent, so its transcript shows the image and the engine reads that file.
    const own = h.manager.attachmentFile(agent.id, image.id);
    assert.equal(sent.images?.[0].path, own.path);
    assert.deepEqual(fs.readFileSync(own.path), PNG);
    const entry = h.manager.entries(agent.id).find(e => e.kind === 'user');
    assert.deepEqual(entry?.images?.map(i => i.id), [image.id]);
  }

  // Later turns see the image post in their backlog.
  h.runner(ada.id).complete(true, 'Looks good.');
  h.runner(bo.id).complete(true, 'Agreed.');
  h.manager.postToChannel(channel.id, '@Ada next step', [ada.id]);
  await settle();
  assert.match(h.runner(ada.id).sent[1].text, /You: \[an image, no text\]/);

  // Deleting the channel deletes its uploads; the agents keep their copies.
  const stored = h.manager.channelAttachmentFile(channel.id, image.id).path;
  h.runner(ada.id).complete(true, 'Done.');
  await settle();
  h.manager.removeChannel(channel.id);
  assert.ok(!fs.existsSync(stored));
  assert.ok(fs.existsSync(h.manager.attachmentFile(ada.id, image.id).path));
});
