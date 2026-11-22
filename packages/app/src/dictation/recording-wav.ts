import { Buffer } from "buffer";

/** Dictation audio is 16 kHz, 16-bit, mono little-endian PCM in base64 segments. */
export const DICTATION_PCM_FORMAT = "audio/pcm;rate=16000;bits=16";
export const DICTATION_SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
export const PCM_BYTES_PER_SECOND = (DICTATION_SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
export const WAV_HEADER_BYTES = 44;
/** Segments decoded between yields, so preparing a long recording never freezes the page. */
export const WAV_SEGMENTS_PER_YIELD = 32;

/** Refuses audio the WAV writer does not describe correctly. */
export function assertDictationPcmFormat(format: string): void {
  if (format !== DICTATION_PCM_FORMAT) {
    throw new Error(`Cannot save dictation audio in format ${format}`);
  }
}

/** Decoded size of one base64 segment, without decoding it. */
export function decodedSegmentBytes(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return (base64.length / 4) * 3 - padding;
}

/** The 44-byte RIFF header for a mono 16 kHz 16-bit WAV with dataBytes of samples. */
export function buildWavHeader(dataBytes: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(new ArrayBuffer(WAV_HEADER_BYTES));
  const view = new DataView(header.buffer);
  const byteRate = (DICTATION_SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** Decodes one segment into its own buffer, the size of that segment only. */
export function decodeSegment(base64: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(base64, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

/**
 * Yields the WAV as a header followed by one part per segment, pausing between batches. No step
 * holds more than one segment beyond the parts themselves, so a long recording is never copied
 * into one large contiguous buffer.
 */
export async function* wavParts(
  segments: readonly string[],
  yieldToEventLoop: () => Promise<void> = defaultYield,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const dataBytes = segments.reduce((total, segment) => total + decodedSegmentBytes(segment), 0);
  yield buildWavHeader(dataBytes);
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0 && index % WAV_SEGMENTS_PER_YIELD === 0) {
      await yieldToEventLoop();
    }
    yield decodeSegment(segments[index]!);
  }
}

/** A file name that sorts by time and never contains characters a share target rejects. */
export function dictationRecordingFileName(createdAt: number): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `dictation-${stamp}.wav`;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}
