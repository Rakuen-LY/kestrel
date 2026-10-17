import type { ImageAttachment } from "@kestrel/protocol";

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Longest edge sent to the model. Beyond this vision encoders downscale anyway. */
const MAX_EDGE = 1568;
const MAX_BYTES = 4 * 1024 * 1024;
const RECODE_QUALITY = 0.86;

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

/** Turns a picked or pasted file into an attachment, shrinking it when needed. */
export async function toAttachment(file: File): Promise<ImageAttachment> {
  if (!ACCEPTED.has(file.type)) {
    throw new ImageRejected(`${file.type || file.name} is not a supported image. Use PNG, JPEG, WebP or GIF.`);
  }
  if (file.size > MAX_BYTES) {
    throw new ImageRejected(`${file.name} is larger than 4 MB.`);
  }
  const original = await readBase64(file);
  if (file.type === "image/gif" || file.size < 400_000) {
    return { mimeType: file.type, data: original, name: file.name };
  }
  return (await shrink(file)) ?? { mimeType: file.type, data: original, name: file.name };
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ImageRejected(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Re-encodes to JPEG at a bounded edge size; returns undefined if the browser cannot decode. */
async function shrink(file: File): Promise<ImageAttachment | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_200_000) {
      bitmap.close();
      return undefined;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return undefined;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = canvas.toDataURL("image/jpeg", RECODE_QUALITY);
    return {
      mimeType: "image/jpeg",
      data: jpeg.slice(jpeg.indexOf(",") + 1),
      name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    };
  } catch {
    return undefined;
  }
}

/** Files from a clipboard or drop event, filtered to images. */
export function imageFilesFrom(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    if (item instanceof File) {
      if (item.type.startsWith("image/")) files.push(item);
      continue;
    }
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export function imageSrc(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
