/**
 * Images for the composer: which files a paste or a drop carries, and getting each one under the
 * server's limits (server/attachments.ts) before it is uploaded.
 */

/** Matches MAX_IMAGE_BYTES in server/attachments.ts. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Matches MAX_IMAGES_PER_MESSAGE in server/attachments.ts. */
export const MAX_IMAGES = 4;
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** A shrunk image keeps this long edge, about what the models look at anyway. */
const MAX_EDGE = 2000;

/** Image files in a clipboard or drop, in order. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) for (const file of Array.from(data.files ?? [])) if (file.type.startsWith('image/')) files.push(file);
  return files;
}

/**
 * The images a paste should attach. A screenshot or a copied image comes alone, and Finder puts the
 * file names beside the files. A spreadsheet or slide app puts a picture of the selection beside its
 * text, and then the text is what was meant, so nothing is attached.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  const files = imageFiles(data);
  if (!files.length) return [];
  const text = data?.getData('text/plain').trim() ?? '';
  if (!text) return files;
  const names = new Set(files.map(f => f.name));
  return text.split(/\r?\n/).every(line => names.has(line.trim())) ? files : [];
}

/** A name for an image that came without one (screenshots paste as "image.png"). */
export function imageName(file: File): string {
  return file.name && file.name !== 'image.png' ? file.name : `pasted-image.${file.type.split('/')[1] || 'png'}`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * The bytes to upload: the file itself when the server takes it as it is, otherwise a PNG (or, when
 * that is still too big, a JPEG) drawn at most MAX_EDGE pixels on its long edge.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (ACCEPTED.has(file.type) && file.size <= MAX_IMAGE_BYTES) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || 'This image'} could not be read. Attach a PNG, JPEG, GIF or WebP image.`);
  }
  try {
    for (const edge of [MAX_EDGE, 1600, 1200]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const [type, quality] of [['image/png', undefined], ['image/jpeg', 0.9], ['image/jpeg', 0.8]] as const) {
        const blob = await canvasBlob(canvas, type, quality);
        if (blob && blob.size <= MAX_IMAGE_BYTES) return blob;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`${file.name || 'This image'} is too large to attach.`);
}
