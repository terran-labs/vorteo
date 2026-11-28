import MarkdownIt from "markdown-it";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceSharedFile } from "../messages.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

// A phone on the relay loads this in one message, so the response stays bounded.
export const MAX_SHARED_FILES = 500;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".heic",
  ".tif",
  ".tiff",
]);
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const LINE_FRAGMENT = /#L?\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;

const markdown = new MarkdownIt({ html: false });
// markdown-it drops `file:` links by default; agents use them for files they deliver.
markdown.validateLink = () => true;

export interface SharedFileThread {
  agentId: string;
  cwd: string;
  rows: readonly AgentTimelineRow[];
}

interface LinkedTarget {
  href: string;
  image: boolean;
}

function linkedTargets(text: string): LinkedTarget[] {
  const targets: LinkedTarget[] = [];
  for (const token of markdown.parse(text, {})) {
    for (const child of token.children ?? []) {
      const href = child.type === "image" ? child.attrGet("src") : child.attrGet("href");
      const isLink = child.type === "image" || child.type === "link_open";
      if (isLink && href) targets.push({ href, image: child.type === "image" });
    }
  }
  return targets;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    // A literal `%` that is not an escape: the href is already the path.
    return href;
  }
}

/** The host path a Markdown target names, or null for web links, anchors and folders. */
function linkedFilePath(href: string, cwd: string): string | null {
  if (href.startsWith("#")) return null;
  let path: string;
  if (/^file:/i.test(href)) {
    try {
      path = fileURLToPath(href.replace(LINE_FRAGMENT, ""));
    } catch {
      // Not a local file URL, such as one naming another host.
      return null;
    }
  } else {
    if (URL_SCHEME.test(href)) return null;
    path = decodeHref(href).replace(LINE_FRAGMENT, "").replace(LINE_SUFFIX, "");
  }
  if (!extname(path)) return null;
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

function threadSharedFiles(thread: SharedFileThread): WorkspaceSharedFile[] {
  const files: WorkspaceSharedFile[] = [];
  for (const row of thread.rows) {
    const shared = { agentId: thread.agentId, seq: row.seq, timestamp: row.timestamp };
    const item = row.item;
    if (item.type === "user_message" && item.queue && item.clientMessageId) {
      for (const attachment of item.queue.attachments) {
        files.push({
          ...shared,
          role: "user",
          kind: attachment.kind ?? "file",
          name: attachment.fileName,
          source: {
            type: "upload",
            messageId: item.clientMessageId,
            attachmentId: attachment.id,
            mimeType: attachment.mimeType,
            size: attachment.size,
          },
        });
      }
    }
    if (item.type === "assistant_message") {
      for (const target of linkedTargets(item.text)) {
        const path = linkedFilePath(target.href, thread.cwd);
        if (!path) continue;
        const isImage = target.image || IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
        files.push({
          ...shared,
          role: "assistant",
          kind: isImage ? "image" : "file",
          name: basename(path),
          source: { type: "link", path, exists: false },
        });
      }
    }
  }
  return files;
}

export async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Missing, unreadable or malformed paths all mean the file cannot be opened.
    return false;
  }
}

function sharedFileIdentity(file: WorkspaceSharedFile): string {
  return file.source.type === "link"
    ? `link:${file.source.path}`
    : `upload:${file.source.attachmentId}`;
}

export interface WorkspaceSharedFileIndex {
  files: WorkspaceSharedFile[];
  truncated: boolean;
}

/**
 * Files exchanged across a workspace's threads, newest first, one entry per file at its
 * latest mention. Reads saved history only, so no thread has to be running.
 */
export async function buildWorkspaceSharedFileIndex(input: {
  threads: readonly SharedFileThread[];
  isFile: (path: string) => Promise<boolean>;
}): Promise<WorkspaceSharedFileIndex> {
  const newestFirst = input.threads
    .flatMap(threadSharedFiles)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.seq - a.seq);
  const latest = new Map<string, WorkspaceSharedFile>();
  for (const file of newestFirst) {
    const identity = sharedFileIdentity(file);
    if (!latest.has(identity)) latest.set(identity, file);
  }
  const unique = [...latest.values()];
  const files = await Promise.all(
    unique.slice(0, MAX_SHARED_FILES).map(async (file) => {
      if (file.source.type === "link") file.source.exists = await input.isFile(file.source.path);
      return file;
    }),
  );
  return { files, truncated: unique.length > MAX_SHARED_FILES };
}
