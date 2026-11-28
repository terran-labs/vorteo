/**
 * Editing the repository's `.github/vorteo-factory.json` from settings. Pure: the editor reads
 * the file text, produces new text and a line diff, and saves only by proposing a pull request.
 * Unknown keys and key order survive an edit, because the file belongs to the owner and newer
 * daemons may understand keys this app does not.
 */

type Json = Record<string, unknown>;

export interface LeanConfigFields {
  /** The primary machine: `order[0]`, one `<serverId>/<projectId>` installation. */
  primary: string | null;
  /** `builder.provider`, such as "codex" or "claude". */
  builderProvider: string | null;
}

export type ParsedLeanConfig =
  | { ok: true; value: Json | null; fields: LeanConfigFields }
  | { ok: false; error: string };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLeanConfig(file: string | null): ParsedLeanConfig {
  if (file === null)
    return { ok: true, value: null, fields: { primary: null, builderProvider: null } };
  let value: unknown;
  try {
    value = JSON.parse(file);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(value)) return { ok: false, error: "The file is not a JSON object." };
  const order = Array.isArray(value.order) ? value.order : [];
  const builder = isObject(value.builder) ? value.builder : {};
  return {
    ok: true,
    value,
    fields: {
      primary: typeof order[0] === "string" ? order[0] : null,
      builderProvider: typeof builder.provider === "string" ? builder.provider : null,
    },
  };
}

/** The file's indent, so an edit does not reformat lines it does not change. */
function indentOf(file: string | null): string | number {
  const match = file ? /\n([ \t]+)"/.exec(file) : null;
  return match?.[1] ?? 2;
}

/**
 * Replaces values in place so lines the owner did not change keep their formatting. Returns
 * null when a key is not in a simple form; the caller then reserializes the whole file.
 */
function editInPlace(file: string, value: Json, edits: Partial<LeanConfigFields>): string | null {
  let text = file;
  if (edits.primary) {
    const order = /("order"\s*:\s*)\[[^[\]]*\]/;
    if (!order.test(text)) return null;
    text = text.replace(order, (_, key: string) => `${key}${JSON.stringify(value.order)}`);
  }
  if (edits.builderProvider) {
    const provider = /("builder"\s*:\s*\{[^{}]*?"provider"\s*:\s*)"(?:[^"\\]|\\.)*"/;
    if (!provider.test(text)) return null;
    text = text.replace(
      provider,
      (_, key: string) => `${key}${JSON.stringify(edits.builderProvider)}`,
    );
  }
  // Only keep the in-place edit when it means exactly the structured edit.
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value) ? text : null;
  } catch {
    return null;
  }
}

/**
 * New file text with only the owner's edits applied; a field the owner did not touch is left
 * exactly as the file has it. A new primary replaces `order[0]` and keeps the rest of the order,
 * minus that machine if it was listed later. A repository without the file gets a minimal lean
 * configuration.
 */
export function applyLeanConfigFields(
  file: string | null,
  edits: Partial<LeanConfigFields>,
): { ok: true; content: string } | { ok: false; error: string } {
  const parsed = parseLeanConfig(file);
  if (!parsed.ok) return parsed;
  const value: Json = parsed.value
    ? { ...parsed.value }
    : { schema: "vorteo-factory", version: 1, mode: "lean" };
  if (edits.primary) {
    const order = Array.isArray(value.order) ? value.order : [];
    value.order = [edits.primary, ...order.slice(1).filter((entry) => entry !== edits.primary)];
  }
  if (edits.builderProvider) {
    const builder = isObject(value.builder) ? value.builder : {};
    value.builder = { ...builder, provider: edits.builderProvider };
  }
  if (file !== null && JSON.stringify(value) === JSON.stringify(parsed.value)) {
    return { ok: true, content: file };
  }
  const inPlace = file === null ? null : editInPlace(file, value, edits);
  if (inPlace !== null) return { ok: true, content: inPlace };
  const trailingNewline = file === null || file.endsWith("\n");
  const content = JSON.stringify(value, null, indentOf(file)) + (trailingNewline ? "\n" : "");
  return { ok: true, content };
}

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** A line diff by longest common subsequence; configuration files are small. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const left = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const right = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        left[i] === right[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: "remove", text: left[i]! });
      i += 1;
    } else {
      lines.push({ kind: "add", text: right[j]! });
      j += 1;
    }
  }
  for (; i < left.length; i += 1) lines.push({ kind: "remove", text: left[i]! });
  for (; j < right.length; j += 1) lines.push({ kind: "add", text: right[j]! });
  return lines;
}

export interface BuilderProviderOption {
  value: string;
  /** False for the file's current value when this installation has no enabled provider of it. */
  available: boolean;
}

/**
 * The provider types the installation has enabled, once each in first-seen order, then the
 * file's current value when it is not among them, marked unavailable so it stays selectable.
 * `resolveType` maps a provider or custom provider to its base type; a provider whose type
 * cannot be resolved is skipped.
 */
export function builderProviderOptions(input: {
  entries: readonly { provider: string; enabled: boolean }[];
  resolveType: (provider: string) => string;
  current: string | null;
}): BuilderProviderOption[] {
  const types: string[] = [];
  for (const entry of input.entries) {
    if (!entry.enabled) continue;
    let type: string;
    try {
      type = input.resolveType(entry.provider);
    } catch {
      continue;
    }
    if (!types.includes(type)) types.push(type);
  }
  const options = types.map((value) => ({ value, available: true }));
  if (input.current && !types.includes(input.current)) {
    options.push({ value: input.current, available: false });
  }
  return options;
}

export interface LeanConfigDraft {
  fields: LeanConfigFields | null;
  /** The text a pull request would propose, or null when the file cannot be edited. */
  content: string | null;
  /** Changed lines only, keyed by their position in the full diff. */
  changes: (DiffLine & { key: string })[];
  /** Why the file cannot be edited here, or null. */
  unreadable: string | null;
}

/** The editor's state for a file and the owner's edits so far. */
export function leanConfigDraft(
  file: string | null,
  edits: Partial<LeanConfigFields>,
): LeanConfigDraft {
  const parsed = parseLeanConfig(file);
  if (!parsed.ok) return { fields: null, content: null, changes: [], unreadable: parsed.error };
  // The dropdowns show the file's values with the owner's edits; only the edits are applied.
  const fields = { ...parsed.fields, ...edits };
  const next = applyLeanConfigFields(file, edits);
  if (!next.ok) return { fields, content: null, changes: [], unreadable: next.error };
  const changes = lineDiff(file ?? "", next.content).flatMap((line, position) =>
    line.kind === "same" ? [] : [{ ...line, key: `${position}` }],
  );
  return { fields, content: next.content, changes, unreadable: null };
}
