import { generateMessageId } from "@/types/stream";
import { isAbsolutePath } from "@/utils/path";
import { isRasterImageMimeType, resolveRasterImageMimeType } from "./file-types";
import type { AttachmentDataSource, SaveAttachmentInput } from "./types";

export function generateAttachmentId(): string {
  return `att_${generateMessageId()}`;
}

export function normalizeMimeType(input: string | undefined | null): string {
  if (!input) {
    return "image/jpeg";
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : "image/jpeg";
}

export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^,]*),([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Malformed data URL for attachment.");
  }
  const metadata = match[1] ?? "";
  const base64 = match[2]?.replace(/\s/g, "");
  const [mimeTypeRaw, ...parameters] = metadata.split(";").map((part) => part.trim());
  const isBase64 = parameters.some((part) => part.toLowerCase() === "base64");
  if (!isBase64) {
    throw new Error("Attachment data URL is not base64 encoded.");
  }
  if (!base64) {
    throw new Error("Attachment data URL is missing base64 payload.");
  }
  return {
    mimeType: normalizeMimeType(mimeTypeRaw),
    base64,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function parseImageDataUrl(
  uri: string,
): { mimeType: string; base64: string; cacheKey: string } | null {
  if (!uri.trim().toLowerCase().startsWith("data:image/")) {
    return null;
  }

  try {
    const parsed = parseDataUrl(uri);
    if (!isRasterImageMimeType(parsed.mimeType)) {
      return null;
    }
    const fingerprint = `${parsed.mimeType}\0${parsed.base64}`;
    return {
      ...parsed,
      cacheKey: `data-image:${parsed.mimeType}:${parsed.base64.length}:${hashString(fingerprint)}`,
    };
  } catch {
    return null;
  }
}

export function createImageSourceCacheKey(source: string): string {
  return parseImageDataUrl(source)?.cacheKey ?? source;
}

export function getFileNameFromPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const fileName = normalized.split("/").pop()?.trim();
  return fileName || null;
}

export function createPreviewAttachmentId(input: {
  mimeType: string;
  path?: string | null;
  size?: number | null;
  modifiedAt?: string | null;
  contentLength?: number | null;
  contentKey?: string | null;
}): string {
  const path = input.path?.trim() ?? "";
  const size = Number.isFinite(input.size) ? String(input.size) : "";
  const modifiedAt = input.modifiedAt?.trim() ?? "";
  const contentLength = Number.isFinite(input.contentLength) ? String(input.contentLength) : "";
  const contentKey = input.contentKey?.trim() ?? "";
  const identity = `${input.mimeType}\0${path}\0${size}\0${modifiedAt}\0${contentLength}`;
  const hash = hashString(contentKey ? `${identity}\0${contentKey}` : identity);
  return `preview_${size || contentLength || "unknown"}_${hash}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected FileReader result while encoding attachment."));
        return;
      }
      const payload = reader.result.split(",", 2)[1];
      if (!payload) {
        reject(new Error("Attachment FileReader result did not contain base64 payload."));
        return;
      }
      resolve(payload);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment blob."));
    });
    reader.readAsDataURL(blob);
  });
}

export function pathToFileUri(path: string): string {
  if (path.startsWith("file://")) {
    return path;
  }

  if (!isAbsolutePath(path)) {
    return path;
  }

  if (path.startsWith("/")) {
    return `file://${path}`;
  }

  // UNC paths: \\server\share -> file://server/share
  if (path.startsWith("\\\\")) {
    return `file:${path.replace(/\\/g, "/")}`;
  }

  return `file:///${path.replace(/\\/g, "/")}`;
}

function decodeFilePathSource(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

function normalizeWindowsDrivePath(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path)) {
    return path;
  }
  return path.replace(/\\/g, "/");
}

function isMarkdownEncodedWindowsDrivePath(source: string): boolean {
  return /^[A-Za-z]:(?:%5[Cc]|%2[Ff])/.test(source);
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  const fileSource = uri.slice("file://".length);
  const decodedPath = decodeFilePathSource(fileSource);
  if (!fileSource.startsWith("/")) {
    return `\\\\${decodedPath.replace(/\//g, "\\")}`;
  }
  return normalizeWindowsDrivePath(decodedPath.replace(/^\/([A-Za-z]:[\\/])/, "$1"));
}

export function localFileSourceToPath(
  source: string,
  // Markdown destinations are URI-encoded; plain filesystem paths are not.
  { decodeHref = false }: { decodeHref?: boolean } = {},
): string {
  if (/^(https?:|data:|blob:)/i.test(source)) {
    return source;
  }
  let path = source;
  if (source.startsWith("file://")) {
    path = fileUriToPath(source);
  } else if (decodeHref || isMarkdownEncodedWindowsDrivePath(source)) {
    path = decodeFilePathSource(source);
  }
  return normalizeWindowsDrivePath(path);
}

export function getFileExtensionFromName(fileName: string | null | undefined): string {
  if (!fileName) {
    return "";
  }
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) {
    return "";
  }
  return fileName.slice(idx);
}

/**
 * Claude scales any image whose long edge exceeds 2,576 px down on its side, and OpenAI's high
 * detail fits 2,048 px, so larger pixels only cost bytes.
 */
export const IMAGE_MAX_LONG_EDGE_PX = 2576;
/**
 * Bedrock and Vertex accept at most 5 MB per image. Base64 grows the bytes by a third, so 3 MiB
 * stays well under that once encoded, and several images fit one session host frame.
 */
export const IMAGE_TARGET_BYTES = 3 * 1024 * 1024;
const REDUCED_JPEG_QUALITY = 0.85;
const MAX_REDUCTION_PASSES = 4;
/** Formats every platform decodes and encodes; others, such as animated GIF, stay as they are. */
const REDUCIBLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ReducedImageType = "image/png" | "image/jpeg";

export interface ImageSize {
  width: number;
  height: number;
}

export interface EncodedImage {
  source: AttachmentDataSource;
  byteSize: number;
}

export interface ResizedImage {
  /** Null when this platform cannot read pixels; the image is then treated as transparent. */
  hasTransparency(): Promise<boolean | null>;
  encode(input: { type: ReducedImageType; quality: number }): Promise<EncodedImage>;
}

export interface OpenedImage extends ImageSize {
  /** Encoded size of the source as given. */
  byteSize: number;
  resize(size: ImageSize): Promise<ResizedImage>;
  /** Frees what open and resize created. */
  release(): Promise<void>;
}

export interface ImageCodec {
  /** Null when this platform cannot read the source; the attachment is then kept as it is. */
  open(input: { source: AttachmentDataSource; mimeType: string }): Promise<OpenedImage | null>;
}

function sourceMimeType(input: SaveAttachmentInput): string | null {
  const { source } = input;
  let fromSource: string | undefined;
  if (source.kind === "blob") fromSource = source.blob.type;
  if (source.kind === "data_url") fromSource = parseDataUrl(source.dataUrl).mimeType;
  return resolveRasterImageMimeType({
    mimeType: input.mimeType || fromSource,
    path: input.fileName ?? (source.kind === "file_uri" ? source.uri : null),
  });
}

function scaledSize(image: ImageSize, scale: number): ImageSize {
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

function renamedForType(fileName: string | null | undefined, type: ReducedImageType) {
  if (!fileName) return fileName;
  const extension = type === "image/png" ? ".png" : ".jpg";
  const current = getFileExtensionFromName(fileName);
  return current ? `${fileName.slice(0, -current.length)}${extension}` : `${fileName}${extension}`;
}

/**
 * Keeps PNG for transparency or when it already fits, since it is lossless; otherwise JPEG when
 * that is smaller. A JPEG source stays JPEG.
 */
async function encodeReduced(
  image: ResizedImage,
  sourceType: string,
): Promise<{
  type: ReducedImageType;
  encoded: EncodedImage;
}> {
  const jpeg = { type: "image/jpeg" as const, quality: REDUCED_JPEG_QUALITY };
  if (sourceType === "image/jpeg") return { type: jpeg.type, encoded: await image.encode(jpeg) };
  const png = await image.encode({ type: "image/png", quality: 1 });
  if (png.byteSize <= IMAGE_TARGET_BYTES || (await image.hasTransparency()) !== false)
    return { type: "image/png", encoded: png };
  const encoded = await image.encode(jpeg);
  return encoded.byteSize < png.byteSize
    ? { type: jpeg.type, encoded }
    : { type: "image/png", encoded: png };
}

/**
 * Shrinks a raster image attachment to what providers use: a long edge of at most
 * IMAGE_MAX_LONG_EDGE_PX, never upscaled, and at most IMAGE_TARGET_BYTES. An image already within
 * both, a type the codec cannot reduce, or a source it cannot read is returned unchanged.
 */
export async function reduceImageForSending(
  input: SaveAttachmentInput,
  codec: ImageCodec,
): Promise<SaveAttachmentInput> {
  const mimeType = sourceMimeType(input);
  if (!mimeType || !REDUCIBLE_IMAGE_TYPES.has(mimeType)) return input;
  const image = await codec.open({ source: input.source, mimeType });
  if (!image) return input;
  try {
    const longEdge = Math.max(image.width, image.height);
    if (longEdge <= IMAGE_MAX_LONG_EDGE_PX && image.byteSize <= IMAGE_TARGET_BYTES) return input;
    let scale = Math.min(1, IMAGE_MAX_LONG_EDGE_PX / longEdge);
    let reduced: { type: ReducedImageType; encoded: EncodedImage } | null = null;
    for (let pass = 0; pass < MAX_REDUCTION_PASSES; pass += 1) {
      reduced = await encodeReduced(await image.resize(scaledSize(image, scale)), mimeType);
      if (reduced.encoded.byteSize <= IMAGE_TARGET_BYTES) break;
      // Encoded size grows roughly with pixel count, so scale each side by the root of the excess.
      scale *= Math.sqrt(IMAGE_TARGET_BYTES / reduced.encoded.byteSize) * 0.9;
    }
    if (!reduced || reduced.encoded.byteSize >= image.byteSize) return input;
    return {
      ...input,
      mimeType: reduced.type,
      fileName: renamedForType(input.fileName, reduced.type),
      source: reduced.encoded.source,
    };
  } finally {
    await image.release();
  }
}
