import { describe, expect, it } from "vitest";
import { buildWorkspaceSharedFileIndex } from "./timeline-shared-files.js";

describe("buildWorkspaceSharedFileIndex", () => {
  it("lists uploads and agent-linked files once each, newest first", async () => {
    const index = await buildWorkspaceSharedFileIndex({
      isFile: async (path) => path !== "/repo/gone.pdf",
      threads: [
        {
          agentId: "agent-a",
          cwd: "/repo",
          rows: [
            {
              seq: 1,
              timestamp: "2026-01-01T00:00:00.000Z",
              item: {
                type: "user_message",
                text: "see attached",
                clientMessageId: "message-1",
                queue: {
                  attachments: [
                    { id: "upload_1", fileName: "spec.pdf", mimeType: "application/pdf", size: 9 },
                  ],
                },
              },
            },
            {
              seq: 2,
              timestamp: "2026-01-01T00:00:01.000Z",
              item: {
                type: "assistant_message",
                text: [
                  "Wrote [the report](docs/report.md#L4) and [an old one](gone.pdf).",
                  "See [the docs](https://example.com/guide.html) and `[not a link](skip.md)`.",
                  "![chart](file:///tmp/out/chart%201.png)",
                ].join("\n\n"),
              },
            },
          ],
        },
        {
          agentId: "agent-b",
          cwd: "/repo",
          rows: [
            {
              seq: 5,
              timestamp: "2026-01-02T00:00:00.000Z",
              item: { type: "assistant_message", text: "Updated [report](/repo/docs/report.md)." },
            },
          ],
        },
      ],
    });

    expect(index.truncated).toBe(false);
    expect(index.files).toEqual([
      {
        agentId: "agent-b",
        seq: 5,
        timestamp: "2026-01-02T00:00:00.000Z",
        role: "assistant",
        kind: "file",
        name: "report.md",
        source: { type: "link", path: "/repo/docs/report.md", exists: true },
      },
      {
        agentId: "agent-a",
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        role: "assistant",
        kind: "file",
        name: "gone.pdf",
        source: { type: "link", path: "/repo/gone.pdf", exists: false },
      },
      {
        agentId: "agent-a",
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        role: "assistant",
        kind: "image",
        name: "chart 1.png",
        source: { type: "link", path: "/tmp/out/chart 1.png", exists: true },
      },
      {
        agentId: "agent-a",
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "user",
        kind: "file",
        name: "spec.pdf",
        source: {
          type: "upload",
          messageId: "message-1",
          attachmentId: "upload_1",
          mimeType: "application/pdf",
          size: 9,
        },
      },
    ]);
  });
});
