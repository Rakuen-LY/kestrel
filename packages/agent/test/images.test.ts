import { describe, expect, it } from "vitest";
import { sanitizeImages } from "../src/images.js";

const png = (bytes: number): string => Buffer.alloc(bytes).toString("base64");

describe("sanitizeImages", () => {
  it("keeps supported images and their names", () => {
    const result = sanitizeImages([{ mimeType: "image/png", data: png(10), name: "shot.png" }]);
    expect(result.images).toEqual([{ mimeType: "image/png", data: png(10), name: "shot.png" }]);
    expect(result.omitted).toEqual([]);
  });

  it("drops unsupported mime types and malformed entries", () => {
    const result = sanitizeImages([
      { mimeType: "image/svg+xml", data: png(4) },
      { mimeType: "image/png", data: "" },
      { mimeType: "image/png" },
      null,
      "not an image",
    ]);
    expect(result.images).toEqual([]);
    expect(result.omitted).toHaveLength(5);
    expect(result.omitted[0]).toContain("unsupported mimeType");
    expect(result.omitted[1]).toContain("no data");
  });

  it("enforces per-image and total byte budgets", () => {
    const limits = { maxImages: 6, maxBytes: 8, maxTotalBytes: 12 };
    const result = sanitizeImages(
      [
        { mimeType: "image/png", data: png(8) },
        { mimeType: "image/png", data: png(8) },
        { mimeType: "image/png", data: png(40) },
      ],
      limits,
    );

    expect(result.images).toHaveLength(1);
    expect(result.omitted).toHaveLength(2);
    expect(result.omitted[0]).toContain("total");
    expect(result.omitted[1]).toContain("over the 8-byte limit");
  });

  it("enforces the image count", () => {
    const result = sanitizeImages(
      [
        { mimeType: "image/png", data: png(4) },
        { mimeType: "image/png", data: png(4) },
      ],
      { maxImages: 1, maxBytes: 100, maxTotalBytes: 1_000 },
    );
    expect(result.images).toHaveLength(1);
    expect(result.omitted).toEqual(["image 2 exceeds the 1-image limit"]);
  });

  it("ignores non-array output from a plugin", () => {
    expect(sanitizeImages(undefined)).toEqual({ images: [], omitted: [] });
    expect(sanitizeImages({ mimeType: "image/png", data: png(4) })).toEqual({ images: [], omitted: [] });
  });
});
