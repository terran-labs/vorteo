import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  BUILDER_UPLOAD_LIMIT_BYTES,
  BuilderGitRefusal,
  builderOpenPullInput,
  builderPublishInput,
  isBuilderPath,
  type createBuilderGit,
} from "./builder-git.js";

export const builderGitMethods = {
  publish: "factory.lean.builder.publish",
  openPullRequest: "factory.lean.builder.open-pull-request",
  publishedHead: "factory.lean.builder.published-head",
} as const;

const readHeadInput = z.strictObject({ issue: builderPublishInput.shape.issue });
export const builderGitInputSchemas = {
  [builderGitMethods.publish]: builderPublishInput,
  [builderGitMethods.openPullRequest]: builderOpenPullInput,
  [builderGitMethods.publishedHead]: readHeadInput,
};

export function invokeBuilderGit(
  runtime: ReturnType<typeof createBuilderGit>,
  /** Taken from authenticated native agent context, never from the uploaded body or query. */
  callerAgentId: string,
  method: string,
  input: unknown,
) {
  switch (method) {
    case builderGitMethods.publish:
      return runtime.publish(callerAgentId, input);
    case builderGitMethods.openPullRequest:
      return runtime.openPullRequest(callerAgentId, input);
    case builderGitMethods.publishedHead:
      return runtime.publishedHead(callerAgentId, readHeadInput.parse(input).issue);
    default:
      throw new BuilderGitRefusal("Unknown Builder Git operation.");
  }
}

const collectInput = builderPublishInput.omit({ changes: true }).extend({
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(512),
        kind: z.enum(["write", "delete"]),
      }),
    )
    .min(1)
    .max(128),
});

/**
 * Run in the Builder's existing sandbox or unprivileged client, never the daemon.
 * The client sends the returned bytes through an agent-authenticated, bounded transport.
 * The model supplies paths and a message; it never needs to encode file contents.
 */
export async function collectBuilderPublish(workspaceRoot: string, raw: unknown) {
  const { files, ...input } = collectInput.parse(raw);
  const root = await realpath(workspaceRoot);
  const changes: z.infer<typeof builderPublishInput>["changes"] = [];
  let remaining = BUILDER_UPLOAD_LIMIT_BYTES;
  for (const file of files) {
    if (!isBuilderPath(file.path)) {
      throw new BuilderGitRefusal("The upload contains an invalid repository path.");
    }
    if (file.kind === "delete") {
      changes.push({ kind: "delete", path: file.path });
      continue;
    }
    const bytes = await readUploadFile(root, file.path, remaining);
    remaining -= bytes.data.length;
    changes.push({
      kind: "write",
      path: file.path,
      base64: bytes.data.toString("base64"),
      executable: bytes.executable,
    });
  }
  return builderPublishInput.parse({ ...input, changes });
}

async function readUploadFile(root: string, path: string, remaining: number) {
  const location = join(root, path);
  if ((await realpath(location)) !== location) {
    throw new BuilderGitRefusal(
      "Builder uploads require regular workspace paths without symbolic links.",
    );
  }
  const handle = await open(
    location,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new BuilderGitRefusal("Builder uploads require regular workspace files.");
    }
    if (before.size > remaining)
      throw new BuilderGitRefusal("The total Builder upload exceeds four MiB.");
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(data, length, data.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new BuilderGitRefusal(
        "The file changed while it was being uploaded. Retry after saving.",
      );
    }
    return { data: data.subarray(0, length), executable: (before.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}
