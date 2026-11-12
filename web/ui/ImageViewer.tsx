import { useRef, useState } from 'react';
import { ZoomViewer } from './ZoomViewer.tsx';

/** An image in the full-window viewer (ZoomViewer), at its own pixel size, fitted once loaded. */
export function ImageViewer({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <ZoomViewer title={title} size={size} onClose={onClose}>
      <img
        src={src}
        alt={title}
        draggable={false}
        onLoad={e => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        style={size ? { width: size.width, height: size.height, maxWidth: 'none' } : undefined}
        className="block select-none"
      />
    </ZoomViewer>
  );
}

/**
 * An image that opens in the viewer: click it, or focus it and press Return or Space. Focus goes
 * back to it when the viewer closes.
 */
export function ExpandableImage({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        title={`${alt}: open full size`}
        aria-label={`Open ${alt} full size`}
        className="block max-w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-content/40"
      >
        <img src={src} alt={alt} className={className} />
      </button>
      {open ? <ImageViewer src={src} title={alt} onClose={close} /> : null}
    </>
  );
}
