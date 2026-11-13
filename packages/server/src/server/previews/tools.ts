import { GetPreviewFeedbackSchema, PublishPreviewSchema } from "@getpaseo/protocol/previews";
import type { PaseoToolDefinition, PaseoToolResult } from "../agent/tools/types.js";
import type { PreviewsService } from "./service.js";

function result(value: unknown): PaseoToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function createPreviewTools(
  previews: Pick<PreviewsService, "publish" | "feedback">,
  callerAgentId?: string,
): PaseoToolDefinition[] {
  return [
    {
      name: "publish_preview",
      title: "Publish a preview for the owner",
      description:
        "Publish an artifact to the owner's Previews gallery: a web page, slide deck, image, PDF, or a live preview link. Files are frozen as an immutable version with a thumbnail, so the owner's rating and comments always refer to exactly what they saw. Publish again with the same lineage key to add a new version. To offer alternatives, publish each option with the same variantSet key and a distinct label; the owner picks a winner with a reason. Publish built output, not a whole project. The owner's comments arrive in this thread as messages headed 'Preview feedback from the owner'. Publishing does not authorize shipping, deploying or sending anything.",
      inputSchema: PublishPreviewSchema,
      handler: async (input) => {
        if (!callerAgentId?.trim()) throw new Error("An agent-scoped caller identity is required");
        const version = await previews.publish(PublishPreviewSchema.parse(input), callerAgentId);
        return result({
          versionId: version.id,
          lineage: version.lineage,
          number: version.number,
          frozen: !version.liveUrl,
          next: "The owner can open it from the Previews gallery in Vorteo. Read their response with get_preview_feedback.",
        });
      },
    },
    {
      name: "get_preview_feedback",
      title: "Read the owner's preview feedback",
      description:
        "Read the owner's star ratings, variant picks with reasons, approvals and comments on published previews. Filter by lineage or versionId, or omit both for everything. Use it before the next build so feedback steers the work without the owner retyping it. An approved version is acceptance of exactly that version, not of later changes.",
      inputSchema: GetPreviewFeedbackSchema,
      handler: async (input) =>
        result(await previews.feedback(GetPreviewFeedbackSchema.parse(input))),
    },
  ];
}
