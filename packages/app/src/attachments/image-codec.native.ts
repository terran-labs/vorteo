import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { createExpoAttachmentFileSystem } from "./attachment-file-system";
import type { AttachmentDataSource } from "./types";
import {
  generateAttachmentId,
  parseDataUrl,
  pathToFileUri,
  type ImageCodec,
  type ImageSize,
  type OpenedImage,
  type ResizedImage,
} from "./utils";

const fileSystem = createExpoAttachmentFileSystem();

interface ReadableSource {
  uri: string;
  /** A copy written for decoding, deleted on release. */
  scratch: boolean;
}

/** Paste hands over a data URL; it is written to a scratch file the manipulator can load. */
async function readableSource(source: AttachmentDataSource): Promise<ReadableSource | null> {
  if (source.kind === "file_uri") return { uri: pathToFileUri(source.uri), scratch: false };
  if (source.kind !== "data_url" || !fileSystem.cacheDirectory) return null;
  const uri = `${fileSystem.cacheDirectory}${generateAttachmentId()}-reduce`;
  const { base64 } = parseDataUrl(source.dataUrl);
  await fileSystem.writeBytes(
    uri,
    Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
  );
  return { uri, scratch: true };
}

async function savedFileSize(uri: string): Promise<number> {
  const info = await fileSystem.getInfo(uri);
  if (!info.exists || info.size === null) throw new Error("The image file could not be read.");
  return info.size;
}

/** Native decoding and encoding through expo-image-manipulator. */
export const imageCodec: ImageCodec = {
  async open({ source }): Promise<OpenedImage | null> {
    const readable = await readableSource(source);
    if (!readable) return null;
    const { uri, scratch } = readable;
    const opened: { release(): void }[] = [];
    async function release(): Promise<void> {
      for (const item of opened.splice(0)) item.release();
      if (scratch) await fileSystem.delete(uri, { idempotent: true });
    }
    try {
      const byteSize = await savedFileSize(uri);
      const original = ImageManipulator.manipulate(uri);
      opened.push(original);
      const decoded = await original.renderAsync();
      opened.push(decoded);
      return {
        width: decoded.width,
        height: decoded.height,
        byteSize,
        async resize(size: ImageSize): Promise<ResizedImage> {
          const context = ImageManipulator.manipulate(uri).resize(size);
          opened.push(context);
          const image = await context.renderAsync();
          opened.push(image);
          return {
            // The manipulator exposes no pixels, so a PNG stays PNG.
            hasTransparency: async () => null,
            async encode({ type, quality }) {
              const saved = await image.saveAsync({
                format: type === "image/png" ? SaveFormat.PNG : SaveFormat.JPEG,
                compress: quality,
              });
              return {
                source: { kind: "file_uri", uri: saved.uri },
                byteSize: await savedFileSize(saved.uri),
              };
            },
          };
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  },
};
