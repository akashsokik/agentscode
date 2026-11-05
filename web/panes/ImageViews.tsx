/**
 * Attached images, after MonoCode's AttachmentChip and ImageLightbox (https://github.com/hardbeat920/monocode,
 * src/features/sessions/ui/AttachmentChip.tsx, MIT License): a small thumbnail with a remove button
 * in the composer, a larger photo in the transcript, and either opens full screen.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ImageAttachment } from '../../shared/types.ts';
import { attachmentUrl } from '../api.ts';
import { AlertCircle, X } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';

/** The image on its own over a dimmed app. Escape or a click anywhere closes it. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Handled here, so an open thread or dialog underneath does not also close.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      style={{ zIndex: LAYER.dialog }}
      className="fixed inset-0 grid cursor-zoom-out place-items-center bg-black/80 p-8"
    >
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
    </div>,
    document.body,
  );
}

/** An image in the composer, before it is sent: uploading, ready or failed, with a way to remove it. */
export function AttachmentChip({ name, preview, uploading, error, onRemove }: {
  name: string;
  preview: string;
  uploading: boolean;
  error?: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group relative shrink-0" title={error ?? name}>
      <button
        type="button"
        aria-label={`Open ${name} full screen`}
        onClick={() => setOpen(true)}
        className={`block cursor-zoom-in rounded-lg outline-none ${error ? 'ring-1 ring-danger' : ''}`}
      >
        <img src={preview} alt="" draggable={false} className={`size-9 rounded-lg object-cover ${uploading || error ? 'opacity-50' : ''}`} />
      </button>
      {uploading ? (
        <span role="status" aria-label={`Uploading ${name}`} className="pointer-events-none absolute inset-0 grid place-items-center text-content">
          <TerminalSpinner />
        </span>
      ) : error ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-danger">
          <AlertCircle className="size-4" strokeWidth={2} />
        </span>
      ) : null}
      <button
        type="button"
        title="Remove"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-content/20 text-content/70 shadow-sm backdrop-blur-sm hover:bg-content/30 hover:text-content"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
      {open ? <ImageLightbox src={preview} alt={name} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The images a sent message carried, as photos above its bubble. */
export function MessageImages({ agentId, images }: { agentId: string; images: ImageAttachment[] }) {
  const [open, setOpen] = useState<ImageAttachment | null>(null);
  return (
    <div className="flex max-w-full flex-wrap justify-end gap-1.5 pb-1.5">
      {images.map(image => (
        <button
          key={image.id}
          type="button"
          title={image.name}
          aria-label={`Open ${image.name} full screen`}
          onClick={() => setOpen(image)}
          className="cursor-zoom-in rounded-2xl outline-none"
        >
          <img
            src={attachmentUrl(agentId, image)}
            alt={image.name}
            loading="lazy"
            draggable={false}
            className={`block rounded-2xl bg-content/5 object-cover ${images.length > 1 ? 'size-28' : 'max-h-60 max-w-60'}`}
          />
        </button>
      ))}
      {open ? <ImageLightbox src={attachmentUrl(agentId, open)} alt={open.name} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
