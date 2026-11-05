/**
 * Images in a channel composer and on channel posts: paste, drop or pick images, see them as chips
 * while they upload, and show them on the post once it is sent. The agent composer (Composer.tsx)
 * does the same inline; this keeps the channel composers to a few lines of wiring.
 */
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import type { ChannelPost } from '../../shared/types.ts';
import { api, channelAttachmentUrl } from '../api.ts';
import { imageFiles, MAX_IMAGES, pastedImages } from '../attachments.ts';
import { AttachmentChip, MessageImages } from './ImageViews.tsx';
import { useComposerImages } from './useComposerImages.ts';

const dragHasFiles = (data: DataTransfer | null) => Array.from(data?.types ?? []).includes('Files');

/**
 * The images for one channel composer. `draftKey` is the composer's draft key (the channel, or
 * channel and thread), so each keeps its own images like its own text; uploads go to the channel.
 * `refocus` puts the caret back in the text box after a drop, a pick or a removal.
 */
export function useChannelImages(channelId: string, draftKey: string, refocus?: () => void) {
  const images = useComposerImages(`channel:${draftKey}`, (blob, name) => api.attachToChannel(channelId, blob, name));
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const refocusRef = useRef(refocus);
  refocusRef.current = refocus;

  /** For the text box: a screenshot or copied image attaches; plain text pastes as usual. */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = pastedImages(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    images.add(files);
  }, [images.add]);

  /** For the composer box: only images attach, anything else gets a note instead of vanishing. */
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(false);
      const files = imageFiles(e.dataTransfer);
      if (files.length) images.add(files);
      else images.setNotice('Only images can be attached: PNG, JPEG, GIF or WebP.');
      refocusRef.current?.();
    },
  };

  /** A hidden file input; render it once and call `pick` from an attach button. */
  const input: ReactNode = (
    <input
      ref={picker}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      hidden
      onChange={e => {
        images.add(Array.from(e.target.files ?? []));
        // Cleared so choosing the same file again still fires a change.
        e.target.value = '';
        refocusRef.current?.();
      }}
    />
  );

  return {
    ...images,
    dragging,
    onPaste,
    dropProps,
    input,
    pick: () => picker.current?.click(),
    full: images.images.length >= MAX_IMAGES,
    remove: (key: string) => { images.remove(key); refocusRef.current?.(); },
  };
}

export type ChannelImages = ReturnType<typeof useChannelImages>;

/**
 * Above the text box: a "drop to attach" overlay while dragging, the images as chips, and any
 * upload problem. Renders nothing when there is nothing to show.
 */
export function ComposerImageTray({ images }: { images: ChannelImages }) {
  return (
    <>
      {images.dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] bg-accent/8 font-sans text-[12px] text-content/70">
          Drop images to attach
        </div>
      ) : null}
      {images.images.length ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {images.images.map(image => (
            <AttachmentChip
              key={image.key}
              name={image.name}
              preview={image.preview}
              uploading={!image.attachment && !image.error}
              error={image.error}
              onRemove={() => images.remove(image.key)}
            />
          ))}
        </div>
      ) : null}
      {images.error ? <p role="alert" className="px-3 pt-2 font-sans text-xs text-danger">{images.error}</p> : null}
    </>
  );
}

/** The images a channel post carried, left-aligned under its author line. Nothing when it has none. */
export function PostImages({ post }: { post: Pick<ChannelPost, 'channelId' | 'images'> }) {
  if (!post.images?.length) return null;
  return <MessageImages images={post.images} url={image => channelAttachmentUrl(post.channelId, image)} align="start" />;
}
