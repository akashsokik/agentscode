import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { ImageAttachment } from '../../shared/types.ts';
import { api } from '../api.ts';
import { imageName, MAX_IMAGES, prepareImage } from '../attachments.ts';

/** An image in the composer: uploading until it has an attachment, or failed with an error. */
export interface PendingImage {
  key: string;
  name: string;
  /** An object URL for the thumbnail, so it shows before the upload finishes. */
  preview: string;
  attachment?: ImageAttachment;
  error?: string;
}

/** Sends one image's bytes to where the message will be posted, and returns its attachment. */
export type ImageUploader = (image: Blob, name: string) => Promise<ImageAttachment>;

// Kept outside the component, per composer, like the text drafts: switching tabs keeps the images,
// and an upload that finishes while the composer is closed still lands.
const lists = new Map<string, PendingImage[]>();
const listeners = new Set<() => void>();
const EMPTY: PendingImage[] = [];

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function change(agentId: string, next: (list: PendingImage[]) => PendingImage[]): void {
  const list = next(lists.get(agentId) ?? EMPTY);
  if (list.length) lists.set(agentId, list);
  else lists.delete(agentId);
  for (const listener of listeners) listener();
}

function patch(agentId: string, key: string, update: Partial<PendingImage>): void {
  change(agentId, list => list.map(image => (image.key === key ? { ...image, ...update } : image)));
}

async function upload(agentId: string, key: string, file: File, name: string, uploader: ImageUploader): Promise<void> {
  try {
    const attachment = await uploader(await prepareImage(file), name);
    patch(agentId, key, { attachment });
  } catch (err) {
    patch(agentId, key, { error: err instanceof Error ? err.message : String(err) });
  }
}

const toAgent = (agentId: string): ImageUploader => (image, name) => api.attach(agentId, image, name);

/**
 * The composer's images, and what can be done with them. `agentId` keys the list: an agent's id,
 * or any other draft key (a channel or thread composer's). Uploads go to that agent unless an
 * `uploader` says where else; it is read when images are added, so it need not be stable.
 */
export function useComposerImages(agentId: string, uploader?: ImageUploader) {
  const uploaderRef = useRef(uploader);
  uploaderRef.current = uploader;
  const images = useSyncExternalStore(subscribe, () => lists.get(agentId) ?? EMPTY);
  const [notice, setNotice] = useState<string | null>(null);

  const add = useCallback((files: File[]) => {
    setNotice(null);
    if (!files.length) return;
    const room = MAX_IMAGES - (lists.get(agentId)?.length ?? 0);
    if (files.length > room) setNotice(`Attach up to ${MAX_IMAGES} images per message.`);
    const taken = files.slice(0, Math.max(0, room));
    const pending = taken.map(file => ({ key: crypto.randomUUID(), name: imageName(file), preview: URL.createObjectURL(file) }));
    if (!pending.length) return;
    change(agentId, list => [...list, ...pending]);
    const send = uploaderRef.current ?? toAgent(agentId);
    taken.forEach((file, i) => void upload(agentId, pending[i].key, file, pending[i].name, send));
  }, [agentId]);

  const remove = useCallback((key: string) => {
    setNotice(null);
    change(agentId, list => list.filter(image => {
      if (image.key === key) URL.revokeObjectURL(image.preview);
      return image.key !== key;
    }));
  }, [agentId]);

  /** After a send: the images went with the message, failed ones included, so the box starts empty. */
  const clear = useCallback(() => {
    setNotice(null);
    for (const image of lists.get(agentId) ?? []) URL.revokeObjectURL(image.preview);
    change(agentId, () => EMPTY);
  }, [agentId]);

  const ready = images.flatMap(image => (image.attachment ? [image.attachment] : []));
  const uploading = images.some(image => !image.attachment && !image.error);
  const error = notice ?? images.findLast(image => image.error)?.error ?? null;
  return { images, ready, uploading, error, add, remove, clear, setNotice };
}
