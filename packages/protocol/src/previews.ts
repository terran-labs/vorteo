import { z } from "zod";

/**
 * Previews gallery: artifacts agents publish while they work, the owner's ratings,
 * variant picks and annotations on them. Every version is an immutable snapshot, so
 * feedback always refers to what the owner actually saw.
 */

/** Unguessable version token. It doubles as the capability in snapshot and viewer URLs. */
export const PreviewVersionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const PreviewKindSchema = z.enum(["web", "deck", "image", "pdf", "url"]);
export type PreviewKind = z.infer<typeof PreviewKindSchema>;

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const SizeSchema = z.object({ w: z.number(), h: z.number() });

/**
 * Where on the page an annotation points. Reported by the previewed page, which is
 * agent-authored, so every field is untrusted display data.
 */
export const PreviewSelectionSchema = z.object({
  kind: z.enum(["element", "region", "page"]),
  selector: z.string().max(300).optional(),
  text: z.string().max(500).optional(),
  tag: z.string().max(40).optional(),
  rect: RectSchema.optional(),
  viewport: SizeSchema.optional(),
  scroll: z.object({ x: z.number(), y: z.number() }).optional(),
  url: z.string().max(2000).optional(),
  devicePixelRatio: z.number().optional(),
});
export type PreviewSelection = z.infer<typeof PreviewSelectionSchema>;

export const PreviewAnnotationSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  comment: z.string().max(4000),
  rating: z.number().int().min(1).max(5).optional(),
  selection: PreviewSelectionSchema.optional(),
  /** queued: handed to the authoring thread's durable queue. stored: kept with the version only. */
  delivery: z.enum(["queued", "stored"]),
});
export type PreviewAnnotation = z.infer<typeof PreviewAnnotationSchema>;

export const PreviewVersionSchema = z.object({
  id: PreviewVersionIdSchema,
  lineage: z.string().min(1).max(120),
  number: z.number().int().positive(),
  title: z.string().min(1).max(200),
  kind: PreviewKindSchema,
  createdAt: z.string().datetime(),
  note: z.string().max(2000).optional(),
  agentId: z.string(),
  agentTitle: z.string().max(200).optional(),
  workspaceId: z.string().optional(),
  /** Entry file inside the frozen snapshot. Absent for url versions. */
  entry: z.string().max(500).optional(),
  /** Present for url versions: a live page, not a frozen copy. */
  liveUrl: z.string().max(2000).optional(),
  sizeBytes: z.number().int().nonnegative(),
  hasThumbnail: z.boolean(),
  variantSetId: z.string().max(160).optional(),
  variantLabel: z.string().max(80).optional(),
  rating: z.number().int().min(1).max(5).nullable(),
  approved: z.boolean(),
  annotations: z.array(PreviewAnnotationSchema),
});
export type PreviewVersion = z.infer<typeof PreviewVersionSchema>;

export const PreviewVariantSetSchema = z.object({
  id: z.string().max(160),
  title: z.string().max(200),
  versionIds: z.array(PreviewVersionIdSchema),
  winnerVersionId: PreviewVersionIdSchema.nullable(),
  reason: z.string().max(2000).nullable(),
  pickedAt: z.string().datetime().nullable(),
});
export type PreviewVariantSet = z.infer<typeof PreviewVariantSetSchema>;

export const PreviewGallerySchema = z.object({
  /** Increases on every change, so clients can skip stale refreshes. */
  revision: z.number().int().nonnegative(),
  versions: z.array(PreviewVersionSchema),
  variantSets: z.array(PreviewVariantSetSchema),
});
export type PreviewGallery = z.infer<typeof PreviewGallerySchema>;

// ---- Agent tools -----------------------------------------------------------------------

export const PublishPreviewSchema = z
  .object({
    title: z.string().trim().min(1).max(200).describe("Short name the owner will recognize."),
    kind: PreviewKindSchema.describe(
      "web: an HTML page or site. deck: HTML slides. image: one image file. pdf: one PDF file. url: a live page that is not frozen, such as a running preview.",
    ),
    lineage: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        "Stable key for this artifact, for example genii-deck. Publishing again with the same key adds a new version to the same gallery entry.",
      ),
    path: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "Absolute path to the file or directory to freeze. Required unless kind is url. A directory is copied whole, without node_modules, .git or symlinks.",
      ),
    entry: z
      .string()
      .max(500)
      .optional()
      .describe("Entry file inside a directory path. Defaults to index.html."),
    url: z
      .string()
      .max(2000)
      .optional()
      .describe("Required when kind is url: the https preview link the owner can open."),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe("What changed in this version, or what you want feedback on."),
    variantSet: z
      .object({
        key: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("Shared key for the options being compared."),
        title: z.string().trim().min(1).max(200).optional(),
        label: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("This option's name, for example A or Serif."),
      })
      .strict()
      .optional()
      .describe(
        "Publish several options with the same key so the owner can pick a winner with a reason.",
      ),
  })
  .strict();
export type PublishPreviewInput = z.infer<typeof PublishPreviewSchema>;

export const GetPreviewFeedbackSchema = z
  .object({
    lineage: z.string().trim().min(1).max(120).optional().describe("Limit to one artifact."),
    versionId: PreviewVersionIdSchema.optional().describe("Limit to one version."),
  })
  .strict();
export type GetPreviewFeedbackInput = z.infer<typeof GetPreviewFeedbackSchema>;

// ---- Client requests -------------------------------------------------------------------

export const PreviewsListRequestSchema = z.object({
  type: z.literal("previews.list.request"),
  requestId: z.string(),
});

export const PreviewsListResponseSchema = z.object({
  type: z.literal("previews.list.response"),
  payload: z.object({
    requestId: z.string(),
    gallery: PreviewGallerySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const PreviewsActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rate"),
    versionId: PreviewVersionIdSchema,
    rating: z.number().int().min(1).max(5).nullable(),
  }),
  z.object({
    kind: z.literal("approve"),
    versionId: PreviewVersionIdSchema,
    approved: z.boolean(),
  }),
  z.object({
    kind: z.literal("pick"),
    variantSetId: z.string().max(160),
    winnerVersionId: PreviewVersionIdSchema.nullable(),
    reason: z.string().max(2000).optional(),
  }),
  z.object({ kind: z.literal("remove"), versionId: PreviewVersionIdSchema }),
  /** Mint a one-time ticket that pairs the owner's browser with the review frame. */
  z.object({ kind: z.literal("ticket") }),
]);
export type PreviewsAction = z.infer<typeof PreviewsActionSchema>;

export const PreviewsActionRequestSchema = z.object({
  type: z.literal("previews.action.request"),
  requestId: z.string(),
  action: PreviewsActionSchema,
});

export const PreviewsActionResponseSchema = z.object({
  type: z.literal("previews.action.response"),
  payload: z.object({
    requestId: z.string(),
    gallery: PreviewGallerySchema.nullable(),
    /** Present only for the ticket action. Single use, short lived. */
    ticket: z.string().optional(),
    error: z.string().nullable(),
  }),
});

/** Pushed to every connected client when the gallery changes. */
export const PreviewsChangedSchema = z.object({
  type: z.literal("previews.changed"),
  payload: z.object({ revision: z.number().int().nonnegative() }),
});
