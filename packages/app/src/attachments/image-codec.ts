import { Buffer } from "buffer";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";
import { isElectronRuntime } from "@/desktop/host";
import type { AttachmentDataSource } from "./types";
import {
  parseDataUrl,
  type ImageCodec,
  type ImageSize,
  type OpenedImage,
  type ResizedImage,
} from "./utils";

// Decoded here rather than fetched, which a page's connect policy may refuse for data URLs.
function base64Blob(base64: string, mimeType: string): Blob {
  return new Blob([new Uint8Array(Buffer.from(base64, "base64"))], { type: mimeType });
}

async function sourceBlob(source: AttachmentDataSource, mimeType: string): Promise<Blob | null> {
  switch (source.kind) {
    case "blob":
      return source.blob;
    case "bytes":
      return new Blob([new Uint8Array(source.bytes)], { type: mimeType });
    case "data_url":
      return base64Blob(parseDataUrl(source.dataUrl).base64, mimeType);
    case "file_uri":
      // Only the desktop app can read a picked or dropped path from the page.
      if (!isElectronRuntime()) return null;
      return base64Blob(await readDesktopFileBase64(source.uri), mimeType);
  }
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  input: { type: string; quality: number },
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type === input.type) resolve(blob);
        else reject(new Error(`This browser cannot encode ${input.type} images.`));
      },
      input.type,
      input.quality,
    );
  });
}

function hasTransparentPixel(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return true;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let alpha = 3; alpha < data.length; alpha += 4) if (data[alpha]! < 255) return true;
  return false;
}

/**
 * Web and desktop draw with the browser's own scaler. expo-image-manipulator's web resize is a
 * per-pixel JavaScript filter on the main thread, which stalls the page for seconds on a photo.
 */
export const imageCodec: ImageCodec = {
  async open({ source, mimeType }): Promise<OpenedImage | null> {
    if (typeof createImageBitmap !== "function") return null;
    const blob = await sourceBlob(source, mimeType);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      byteSize: blob.size,
      async resize(size: ImageSize): Promise<ResizedImage> {
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image reduction needs a 2D canvas.");
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        return {
          hasTransparency: async () => hasTransparentPixel(canvas),
          async encode(input) {
            const encoded = await canvasBlob(canvas, input);
            return { source: { kind: "blob", blob: encoded }, byteSize: encoded.size };
          },
        };
      },
      async release() {
        bitmap.close();
      },
    };
  },
};
