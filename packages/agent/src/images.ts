import type { ImageAttachment } from "@kestrel/protocol";

export interface ImageSanitizeLimits {
  maxImages: number;
  maxBytes: number;
  maxTotalBytes: number;
}

export interface SanitizedImages {
  images: ImageAttachment[];
  /** Human-readable reasons, one per dropped image. */
  omitted: string[];
}

const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const TOOL_IMAGE_LIMITS: ImageSanitizeLimits = {
  maxImages: 6,
  maxBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
};

/**
 * Tools are plugins, so their output is untrusted. Images that exceed provider
 * or API budgets are dropped with a note rather than failing the whole call.
 */
export function sanitizeImages(
  input: unknown,
  limits: ImageSanitizeLimits = TOOL_IMAGE_LIMITS,
): SanitizedImages {
  if (!Array.isArray(input) || input.length === 0) return { images: [], omitted: [] };

  const images: ImageAttachment[] = [];
  const omitted: string[] = [];
  let total = 0;

  for (const [index, candidate] of input.entries()) {
    if (typeof candidate !== "object" || candidate === null) {
      omitted.push(`image ${index + 1} is not an object`);
      continue;
    }
    const { mimeType, data, name } = candidate as Partial<ImageAttachment>;
    if (typeof mimeType !== "string" || !MIME.has(mimeType)) {
      omitted.push(`image ${index + 1} has an unsupported mimeType`);
      continue;
    }
    if (typeof data !== "string" || data.length === 0) {
      omitted.push(`image ${index + 1} has no data`);
      continue;
    }
    const bytes = Buffer.byteLength(data, "base64");
    if (bytes > limits.maxBytes) {
      omitted.push(`image ${index + 1} is ${bytes} bytes, over the ${limits.maxBytes}-byte limit`);
      continue;
    }
    if (images.length >= limits.maxImages) {
      omitted.push(`image ${index + 1} exceeds the ${limits.maxImages}-image limit`);
      continue;
    }
    if (total + bytes > limits.maxTotalBytes) {
      omitted.push(`image ${index + 1} would exceed the ${limits.maxTotalBytes}-byte total`);
      continue;
    }
    total += bytes;
    images.push({
      mimeType,
      data,
      ...(typeof name === "string" && name ? { name } : {}),
    });
  }

  return { images, omitted };
}
