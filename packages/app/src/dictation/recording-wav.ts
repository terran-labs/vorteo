import { Buffer } from "buffer";

/** Dictation audio is 16 kHz, 16-bit, mono little-endian PCM in base64 segments. */
export const DICTATION_SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const WAV_HEADER_BYTES = 44;

/**
 * Builds a WAV file from base64 PCM segments, so a recording the Host could not transcribe can
 * be kept or played elsewhere. Pure and synchronous: about 7.7 MB for four minutes.
 */
export function buildDictationWav(segments: readonly string[]): Uint8Array<ArrayBuffer> {
  const chunks = segments.map((segment) => Buffer.from(segment, "base64"));
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const wav = new Uint8Array(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
  const view = new DataView(wav.buffer);
  const byteRate = (DICTATION_SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;

  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.length;
  }
  return wav;
}

/** A file name that sorts by time and never contains characters a share target rejects. */
export function dictationRecordingFileName(createdAt: number): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `dictation-${stamp}.wav`;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}
