import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ImageAttachment, ImageMediaType } from '../shared/types.ts';
import { HttpError } from './errors.ts';

// Images the user pastes or attaches to a message, ported from Agent Office. They are stored
// once, per agent, under the data folder: Claude Code gets them as image blocks and Codex as
// --image files.

/** 5 MB once base64-encoded, the Claude API's limit for one image. */
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGES_PER_MESSAGE = 4;

const KINDS: Record<ImageMediaType, { ext: string; matches: (bytes: Buffer) => boolean }> = {
  'image/png': { ext: 'png', matches: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', matches: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', matches: b => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { ext: 'webp', matches: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/** Stored names are generated here, so anything else is not one of ours. */
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/** The image type, read from the bytes rather than from what the browser claimed. SVG is never accepted. */
export function sniffImage(bytes: Buffer): ImageMediaType | null {
  for (const [type, kind] of Object.entries(KINDS) as [ImageMediaType, (typeof KINDS)[ImageMediaType]][]) {
    if (kind.matches(bytes)) return type;
  }
  return null;
}

function typeOf(id: string): ImageMediaType {
  const ext = id.slice(id.lastIndexOf('.') + 1);
  return (Object.keys(KINDS) as ImageMediaType[]).find(type => KINDS[type].ext === ext)!;
}

function displayName(raw: unknown, fallback: string): string {
  let name = typeof raw === 'string' ? raw : '';
  try { name = decodeURIComponent(name); } catch { /* keep it as sent */ }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 120) || fallback;
}

export class Attachments {
  private root: string;
  constructor(root: string) { this.root = root; }

  /** Callers pass a known agent id; ids never come straight from a request. */
  private dir(agentId: string): string {
    return path.join(this.root, agentId);
  }

  save(agentId: string, body: unknown, name?: unknown): ImageAttachment {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Choose an image to attach.');
    if (body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Images can be up to 3.75 MB.');
    const mediaType = sniffImage(body);
    if (!mediaType) throw new HttpError(415, 'Attach a PNG, JPEG, GIF or WebP image.');
    const id = `${randomUUID()}.${KINDS[mediaType].ext}`;
    fs.mkdirSync(this.dir(agentId), { recursive: true });
    fs.writeFileSync(path.join(this.dir(agentId), id), body, { flag: 'wx' });
    return { id, name: displayName(name, `image.${KINDS[mediaType].ext}`), mediaType, size: body.length };
  }

  /** The stored file behind an attachment id, or a 404. */
  file(agentId: string, id: unknown): { path: string; mediaType: ImageMediaType; size: number } {
    if (typeof id !== 'string' || !STORED_NAME.test(id)) throw new HttpError(404, 'Image not found.');
    const file = path.join(this.dir(agentId), id);
    let size: number;
    try { size = fs.statSync(file).size; } catch { throw new HttpError(404, 'Image not found.'); }
    return { path: file, mediaType: typeOf(id), size };
  }

  /** Check the images a message names: each must be one this agent uploaded. */
  resolve(agentId: string, input: unknown): { attachment: ImageAttachment; path: string }[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new HttpError(400, 'Images must be a list.');
    if (input.length > MAX_IMAGES_PER_MESSAGE) throw new HttpError(400, `Attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
    return input.map(item => {
      const ref = (item && typeof item === 'object' ? item : { id: item }) as { id?: unknown; name?: unknown };
      let stored: ReturnType<Attachments['file']>;
      try { stored = this.file(agentId, ref.id); } catch { throw new HttpError(400, 'An attached image is no longer available. Attach it again.'); }
      const id = ref.id as string;
      return { attachment: { id, name: displayName(ref.name, id), mediaType: stored.mediaType, size: stored.size }, path: stored.path };
    });
  }

  /**
   * Copy an image stored elsewhere (a channel post's) into this owner's folder under the same id,
   * so a message that carries it reads and shows it like one the user attached here.
   */
  adopt(agentId: string, image: { attachment: ImageAttachment; path: string }): { attachment: ImageAttachment; path: string } {
    if (!STORED_NAME.test(image.attachment.id)) throw new HttpError(400, 'An attached image is no longer available. Attach it again.');
    const target = path.join(this.dir(agentId), image.attachment.id);
    fs.mkdirSync(this.dir(agentId), { recursive: true });
    try {
      fs.copyFileSync(image.path, target, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      // Ids are never reused, so a file already there is this same image, delivered before.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { attachment: image.attachment, path: target };
  }

  remove(agentId: string): void {
    fs.rmSync(this.dir(agentId), { recursive: true, force: true });
  }
}
