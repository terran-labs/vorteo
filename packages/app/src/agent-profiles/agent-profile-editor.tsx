import { useCallback, useMemo, useState, type ReactElement } from "react";
import type { SharedProviderPreferences, AgentProfile } from "@getpaseo/protocol/messages";
import { AgentProfileCenteredModal } from "./settings/agent-profile-page";
import { useSharedProviderProfiles } from "./settings/use-shared-provider-profiles";
import { generateAgentProfileId } from "./internal/profile-id";
import type { AgentProfileSeed, AgentProfileValue } from "./internal/profile-form-model";
import { useAgentProfiles } from "./internal/use-agent-profiles";

export interface AgentProfileEditorControls {
  /** Open the create form pre-filled with provider, model, and suggested name. */
  openCreateFromModel: (seed: AgentProfileSeed) => void;
  /** Open the edit form for one profile. */
  openEdit: (profileId: string) => void;
  /** Render once where a sheet can portal; it self-hides until opened. */
  element: ReactElement | null;
}

interface EditorRequest {
  mode: "create" | "edit";
  profile: AgentProfile;
  shared?: SharedProviderPreferences;
}

/**
 * The model chooser's create/edit surface. Owns the write path so call sites
 * never see `saveProfiles` or construct profile records themselves.
 */
export function useAgentProfileEditor(serverId: string | null): AgentProfileEditorControls {
  const { profiles, legacyProfiles, saveProfiles, supportsSharedPreferences } =
    useAgentProfiles(serverId);
  const [request, setRequest] = useState<EditorRequest | null>(null);
  const sharedProfiles = useSharedProviderProfiles(serverId ?? "", request?.profile.provider ?? "");

  const openCreateFromModel = useCallback(
    (seed: AgentProfileSeed) => {
      setRequest({
        mode: "create",
        shared: supportsSharedPreferences ? sharedProfiles.shared : undefined,
        profile: {
          id: generateAgentProfileId(),
          name: seed.name ?? "",
          provider: seed.provider,
          ...(seed.modelId ? { model: seed.modelId } : {}),
        },
      });
    },
    [supportsSharedPreferences, sharedProfiles.shared],
  );

  const openEdit = useCallback(
    (profileId: string) => {
      const profile = profiles?.find((entry) => entry.id === profileId);
      if (!profile) {
        return;
      }
      setRequest({
        mode: "edit",
        profile,
        shared: supportsSharedPreferences ? sharedProfiles.shared : undefined,
      });
    },
    [profiles, supportsSharedPreferences, sharedProfiles.shared],
  );

  const close = useCallback(() => setRequest(null), []);

  const handleSave = useCallback(
    async (value: AgentProfileValue) => {
      if (supportsSharedPreferences) {
        if (!request?.shared) throw new Error("Reconnect to load shared profiles before saving.");
        const id =
          request.mode === "edit"
            ? decodeURIComponent(request.profile.id.split("/")[2] ?? request.profile.id)
            : request.profile.id;
        await sharedProfiles.saveWorkflow({ ...value, id }, request.shared);
        setRequest(null);
        return;
      }
      const current = legacyProfiles;
      const editing = request?.mode === "edit" ? request.profile : undefined;
      if (
        editing &&
        JSON.stringify(current.find((entry) => entry.id === editing.id)) !== JSON.stringify(editing)
      ) {
        throw new Error(
          "This profile changed while you were editing. Close and reopen it before saving.",
        );
      }
      const next: AgentProfile[] = editing
        ? current.map((entry) =>
            entry.id === editing.id
              ? { id: entry.id, isDefault: entry.isDefault, ...value }
              : entry,
          )
        : [...current, { id: request?.profile.id ?? generateAgentProfileId(), ...value }];
      await saveProfiles(next);
      setRequest(null);
    },
    [legacyProfiles, request, saveProfiles, sharedProfiles, supportsSharedPreferences],
  );

  const handleDelete = useCallback(async () => {
    if (request?.mode !== "edit") return;
    if (supportsSharedPreferences) {
      if (!request.shared) throw new Error("Reconnect to load shared profiles before deleting.");
      await sharedProfiles.deleteWorkflow(
        decodeURIComponent(request.profile.id.split("/")[2] ?? request.profile.id),
        request.shared,
      );
      setRequest(null);
      return;
    }
    const current = legacyProfiles;
    if (
      JSON.stringify(current.find((entry) => entry.id === request.profile.id)) !==
      JSON.stringify(request.profile)
    ) {
      throw new Error(
        "This profile changed while you were editing. Close and reopen it before deleting.",
      );
    }
    await saveProfiles(current.filter((entry) => entry.id !== request.profile.id));
    setRequest(null);
  }, [legacyProfiles, request, saveProfiles, sharedProfiles, supportsSharedPreferences]);
  const sharedScope = useMemo(
    () =>
      request?.shared
        ? { kind: "workflow" as const, providerType: sharedProfiles.providerType }
        : undefined,
    [request?.shared, sharedProfiles.providerType],
  );
  const element = useMemo(
    () =>
      request ? (
        <AgentProfileCenteredModal
          key={request.profile.id}
          serverId={serverId ?? ""}
          mode={request.mode}
          profile={request.profile}
          sharedScope={sharedScope}
          onBack={close}
          onSave={handleSave}
          onDelete={request.mode === "edit" ? handleDelete : undefined}
        />
      ) : null,
    [close, handleSave, handleDelete, request, serverId, sharedScope],
  );

  return useMemo(
    () => ({ openCreateFromModel, openEdit, element }),
    [openCreateFromModel, openEdit, element],
  );
}
