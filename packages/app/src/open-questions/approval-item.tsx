import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openConversationTarget } from "./conversation-target";
import type { ThreadApproval } from "./global-model";

/** The command a tool approval would run, in full, or its input when it is not a shell command. */
export function approvalCommand(input: Record<string, unknown> | undefined): string {
  const command = input?.command;
  if (typeof command === "string") return command;
  return JSON.stringify(input ?? {}, null, 2);
}

/**
 * A thread stopped on a tool approval, answerable here (#659). Accept is offered only after the
 * owner has expanded the full command once; until then the primary action opens the thread at
 * the approval. Deny is always one tap.
 */
export function ApprovalItem({
  approval,
  first,
  onBeforeNavigate,
}: {
  approval: ThreadApproval;
  first: boolean;
  onBeforeNavigate?: () => void;
}) {
  const { request } = approval;
  const client = useSessionStore((state) => state.sessions[approval.serverId]?.client ?? null);
  const command = useMemo(() => approvalCommand(request.input), [request.input]);
  const firstLine = command.split("\n", 1)[0] ?? "";
  const [expanded, setExpanded] = useState(false);
  const [seenFull, setSeenFull] = useState(false);
  const toggle = useCallback(() => {
    setExpanded((value) => !value);
    setSeenFull(true);
  }, []);
  const mutation = useMutation({
    mutationFn: async (response: AgentPermissionResponse) => {
      if (!client) throw new Error("This host is not connected.");
      return client.respondToPermissionAndWait(approval.agentId, request.id, response, 15000);
    },
  });
  const { mutate, isPending, isError } = mutation;
  const accept = useCallback(
    () => mutate({ behavior: "allow", selectedActionId: "accept" }),
    [mutate],
  );
  const deny = useCallback(
    () => mutate({ behavior: "deny", selectedActionId: "deny", message: "Denied by user" }),
    [mutate],
  );
  const openThread = useCallback(() => {
    onBeforeNavigate?.();
    const askedSeq = request.metadata?.askedSeq;
    const askedEpoch = request.metadata?.askedEpoch;
    openConversationTarget(
      {
        serverId: approval.serverId,
        agentId: approval.agentId,
        kind: "permission",
        id: request.id,
        seq: typeof askedSeq === "number" ? askedSeq : null,
        epoch: typeof askedEpoch === "string" ? askedEpoch : null,
      },
      navigateToAgent,
    );
  }, [approval.agentId, approval.serverId, onBeforeNavigate, request.id, request.metadata]);
  // What Vorteo's own scan found that deletes, when it found something (#659, part B).
  const deleteFinding = request.metadata?.deleteFinding;
  // A long single line is cut off too, so every command is expanded once before Accept.
  const canAccept = seenFull;
  return (
    <View
      style={[styles.item, taskCardStyles.proseInset, !first && taskCardStyles.separator]}
      testID={`global-approval-${request.id}`}
    >
      <Text style={styles.title}>{`${approval.threadTitle} is stopped until you answer.`}</Text>
      {approval.modeLabel ? (
        <Text style={styles.muted}>{`This thread is in ${approval.modeLabel} mode.`}</Text>
      ) : null}
      {approval.cwd ? (
        <Text style={styles.muted} numberOfLines={1}>
          {`Working directory: ${approval.cwd}`}
        </Text>
      ) : null}
      {request.description ? <Text style={styles.reason}>{request.description}</Text> : null}
      {typeof deleteFinding === "string" ? (
        <Text style={styles.deletes} testID={`global-approval-deletes-${request.id}`}>
          {`Deletes: ${deleteFinding}`}
        </Text>
      ) : null}
      {expanded ? (
        <ScrollView
          style={styles.commandScroll}
          edgeFade={false}
          testID={`global-approval-command-${request.id}`}
        >
          <Text style={styles.command} selectable>
            {command}
          </Text>
        </ScrollView>
      ) : (
        <Text style={styles.command} numberOfLines={1}>
          {firstLine}
        </Text>
      )}
      <Button
        variant="ghost"
        size="sm"
        onPress={toggle}
        testID={`global-approval-expand-${request.id}`}
      >
        {expanded ? "Hide full command" : "Show full command"}
      </Button>
      {isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          The answer did not reach the thread. Try again, or open the thread.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {canAccept ? (
          <Button
            variant="default"
            size="md"
            onPress={accept}
            disabled={isPending}
            testID={`global-approval-accept-${request.id}`}
          >
            Accept
          </Button>
        ) : (
          <Button
            variant="default"
            size="md"
            leftIcon={ArrowUpRight}
            onPress={openThread}
            testID={`global-approval-open-${request.id}`}
          >
            Open thread
          </Button>
        )}
        <Button
          variant="secondary"
          size="md"
          onPress={deny}
          disabled={isPending}
          testID={`global-approval-deny-${request.id}`}
        >
          Deny
        </Button>
        {canAccept ? (
          <Button
            variant="ghost"
            size="md"
            leftIcon={ArrowUpRight}
            onPress={openThread}
            testID={`global-approval-open-${request.id}`}
          >
            Open thread
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  item: { gap: theme.spacing[1.5], paddingVertical: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  reason: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  commandScroll: { maxHeight: 240 },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  deletes: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
