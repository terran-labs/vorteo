import { describe, expect, it } from "vitest";
import {
  createImageSourceCacheKey,
  createPreviewAttachmentId,
  fileUriToPath,
  localFileSourceToPath,
  parseDataUrl,
  parseImageDataUrl,
  pathToFileUri,
  IMAGE_MAX_LONG_EDGE_PX,
  IMAGE_TARGET_BYTES,
  reduceImageForSending,
  type ImageCodec,
  type ImageSize,
} from "./utils";

describe("pathToFileUri", () => {
  it("converts POSIX absolute paths to file URIs", () => {
    expect(pathToFileUri("/home/user/file.txt")).toBe("file:///home/user/file.txt");
  });

  it("converts Windows drive-letter paths to file URIs", () => {
    expect(pathToFileUri("C:\\Users\\file.txt")).toBe("file:///C:/Users/file.txt");
  });

  it("converts UNC paths to host-based file URIs", () => {
    expect(pathToFileUri("\\\\server\\share\\dir")).toBe("file://server/share/dir");
  });

  it("passes through file URIs unchanged", () => {
    expect(pathToFileUri("file:///already/uri")).toBe("file:///already/uri");
  });

  it("passes through relative paths unchanged", () => {
    expect(pathToFileUri("relative/path")).toBe("relative/path");
  });
});

describe("fileUriToPath", () => {
  it("converts Windows drive-letter file URIs back to paths", () => {
    expect(fileUriToPath("file:///C:/Users/file.txt")).toBe("C:/Users/file.txt");
  });

  it("converts host-based file URIs back to UNC paths", () => {
    expect(fileUriToPath("file://server/share/shot%231.png")).toBe("\\\\server\\share\\shot#1.png");
  });
});

describe("localFileSourceToPath", () => {
  it.each([
    "https://example.com/image%20name.png",
    "data:image/png;base64,abc%20",
    "blob:https://example.com/image%20name",
  ])("preserves a direct Markdown image URI: %s", (source) => {
    expect(localFileSourceToPath(source, { decodeHref: true })).toBe(source);
  });

  it("preserves malformed percent escapes rather than throwing", () => {
    expect(localFileSourceToPath("/tmp/100%.png", { decodeHref: true })).toBe("/tmp/100%.png");
  });

  it("decodes markdown-encoded Windows drive-letter paths", () => {
    expect(localFileSourceToPath("C:%5CUsers%5Cfile.txt")).toBe("C:/Users/file.txt");
  });

  it("preserves literal percent sequences in plain local paths", () => {
    expect(localFileSourceToPath("/tmp/image%20with%20literal%20percent.png")).toBe(
      "/tmp/image%20with%20literal%20percent.png",
    );
  });
});

describe("parseDataUrl", () => {
  it("accepts base64 data URLs with media-type parameters", () => {
    expect(parseDataUrl("data:image/png;charset=utf-8;name=preview;base64,AAECAw==")).toEqual({
      mimeType: "image/png",
      base64: "AAECAw==",
    });
  });

  it("rejects non-base64 data URLs", () => {
    expect(() => parseDataUrl("data:image/png,not-base64")).toThrow(
      "Attachment data URL is not base64 encoded.",
    );
  });
});

describe("parseImageDataUrl", () => {
  it("returns a compact cache key for image data URLs", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(512)}`;

    expect(parseImageDataUrl(dataUrl)).toMatchObject({
      mimeType: "image/png",
      base64: "a".repeat(512),
    });
    expect(createImageSourceCacheKey(dataUrl)).toMatch(/^data-image:image\/png:512:/);
    expect(createImageSourceCacheKey(dataUrl)).not.toContain("a".repeat(128));
  });

  it("ignores non-image data URLs", () => {
    expect(parseImageDataUrl("data:text/plain;base64,SGVsbG8=")).toBeNull();
  });

  it("ignores SVG data URLs", () => {
    expect(parseImageDataUrl("data:image/svg+xml;base64,PHN2ZyAvPg==")).toBeNull();
  });

  it("distinguishes image data that differs only in the middle", () => {
    const prefix = "a".repeat(64);
    const suffix = "z".repeat(64);
    const first = `data:image/png;base64,${prefix}${"b".repeat(256)}${suffix}`;
    const second = `data:image/png;base64,${prefix}${"c".repeat(256)}${suffix}`;

    expect(createImageSourceCacheKey(first)).not.toBe(createImageSourceCacheKey(second));
  });

  it("gives equal-length preview content distinct attachment identities", () => {
    expect(
      createPreviewAttachmentId({
        mimeType: "image/png",
        contentLength: 512,
        contentKey: "first-content",
      }),
    ).not.toBe(
      createPreviewAttachmentId({
        mimeType: "image/png",
        contentLength: 512,
        contentKey: "second-content",
      }),
    );
  });
});

describe("reduceImageForSending", () => {
  /** Encodes to a size proportional to its pixels, as a screenshot roughly does. */
  function fakeCodec(original: ImageSize & { byteSize: number }) {
    const encodedSizes: (ImageSize & { byteSize: number })[] = [];
    const bytesPerPixel = original.byteSize / (original.width * original.height);
    const codec: ImageCodec = {
      async open() {
        return {
          ...original,
          async resize(size) {
            return {
              hasTransparency: async () => false,
              async encode({ type, quality }) {
                const jpegFactor = type === "image/jpeg" ? quality / 4 : 1;
                const byteSize = Math.round(size.width * size.height * bytesPerPixel * jpegFactor);
                encodedSizes.push({ ...size, byteSize });
                return { source: { kind: "bytes", bytes: new Uint8Array(1) }, byteSize };
              },
            };
          },
          async release() {},
        };
      },
    };
    return { codec, encodedSizes };
  }
  const screenshot = {
    mimeType: "image/png",
    fileName: "screenshot.png",
    source: { kind: "bytes" as const, bytes: new Uint8Array(1) },
  };

  it("reduces an image over the limits below them and leaves one within them alone", async () => {
    const large = fakeCodec({ width: 5120, height: 2880, byteSize: 14_900_000 });
    const reduced = await reduceImageForSending(screenshot, large.codec);
    expect(reduced).toMatchObject({ mimeType: "image/jpeg", fileName: "screenshot.jpg" });
    const final = large.encodedSizes.at(-1)!;
    expect(Math.max(final.width, final.height)).toBeLessThanOrEqual(IMAGE_MAX_LONG_EDGE_PX);
    expect(final.byteSize).toBeLessThanOrEqual(IMAGE_TARGET_BYTES);

    const small = fakeCodec({ width: 1440, height: 900, byteSize: IMAGE_TARGET_BYTES / 2 });
    expect(await reduceImageForSending(screenshot, small.codec)).toBe(screenshot);
    expect(small.encodedSizes).toEqual([]);
  });
});
