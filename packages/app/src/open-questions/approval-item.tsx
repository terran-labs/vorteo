import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openConversationTarget } from "./conversation-target";
import { MAX_ACCEPT_LINES, visibleText, type ThreadApproval } from "./global-model";

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
  const shown = useMemo(() => visibleText(command), [command]);
  const lines = useMemo(() => shown.split("\n"), [shown]);
  const tooLong = lines.length > MAX_ACCEPT_LINES;
  const escaped = shown !== command;
  const firstLine = lines[0] ?? "";
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  // Accept waits until every line has been on screen: the whole command fit in the box, or the
  // box was scrolled to its end. Expanding alone is not enough, since a long harmless prefix can
  // push the end of the command below the box.
  const [seenFull, setSeenFull] = useState(false);
  const box = useRef({ viewport: 0, content: 0 });
  const checkFits = useCallback(() => {
    const { viewport, content } = box.current;
    if (viewport > 0 && content > 0 && content <= viewport + 1) setSeenFull(true);
  }, []);
  const onBoxLayout = useCallback(
    (event: LayoutChangeEvent) => {
      box.current.viewport = event.nativeEvent.layout.height;
      checkFits();
    },
    [checkFits],
  );
  const onContentSize = useCallback(
    (_width: number, height: number) => {
      box.current.content = height;
      checkFits();
    },
    [checkFits],
  );
  const onBoxScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 2) setSeenFull(true);
  }, []);
  // Plan, mode and other approvals carry choices this card does not offer (#659).
  const answerableHere = request.kind === "tool";
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
  const canAccept = answerableHere && seenFull && !tooLong;
  const lineCount = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  return (
    <View
      style={[styles.item, taskCardStyles.proseInset, !first && taskCardStyles.separator]}
      testID={`global-approval-${request.id}`}
    >
      <ApprovalContext approval={approval} />
      {expanded ? (
        <ScrollView
          style={styles.commandScroll}
          edgeFade={false}
          onLayout={onBoxLayout}
          onContentSizeChange={onContentSize}
          onScroll={onBoxScroll}
          scrollEventThrottle={64}
          testID={`global-approval-command-${request.id}`}
        >
          <Text style={styles.command} selectable>
            {shown}
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
        {expanded ? `Hide full command (${lineCount})` : `Show full command (${lineCount})`}
      </Button>
      <ApprovalNotices
        escaped={escaped}
        tooLong={tooLong}
        answerableHere={answerableHere}
        awaitingScroll={expanded && !seenFull}
      />
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
        {answerableHere ? (
          <Button
            variant="secondary"
            size="md"
            onPress={deny}
            disabled={isPending}
            testID={`global-approval-deny-${request.id}`}
          >
            Deny
          </Button>
        ) : null}
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

/** Which thread is stopped, in what mode and where, and why it asks. */
function ApprovalContext({ approval }: { approval: ThreadApproval }) {
  // What Vorteo's own scan found that deletes, when it found something (#659, part B).
  const deleteFinding = approval.request.metadata?.deleteFinding;
  return (
    <>
      {/* The title is the agent's own: quoted and on one line, so it can't read as reassurance. */}
      <Text style={styles.title} numberOfLines={1}>
        {`Thread “${visibleText(approval.threadTitle)}” is stopped until you answer.`}
      </Text>
      {approval.modeLabel ? (
        <Text style={styles.muted}>{`This thread is in ${approval.modeLabel} mode.`}</Text>
      ) : null}
      {approval.cwd ? (
        <Text style={styles.muted} numberOfLines={1}>
          {`Working directory: ${approval.cwd}`}
        </Text>
      ) : null}
      {approval.request.description ? (
        <Text style={styles.reason}>{approval.request.description}</Text>
      ) : null}
      {typeof deleteFinding === "string" ? (
        <Text style={styles.deletes} testID={`global-approval-deletes-${approval.request.id}`}>
          {`Deletes: ${deleteFinding}`}
        </Text>
      ) : null}
    </>
  );
}

/** Why Accept is not offered, or what to look at before using it. */
function ApprovalNotices(props: {
  escaped: boolean;
  tooLong: boolean;
  answerableHere: boolean;
  awaitingScroll: boolean;
}) {
  const { escaped, tooLong, answerableHere, awaitingScroll } = props;
  return (
    <>
      {escaped ? (
        <Text style={styles.deletes}>
          This command contains hidden or control characters, shown as ⟨U+…⟩.
        </Text>
      ) : null}
      {answerableHere && tooLong ? (
        <Text style={styles.muted}>
          {`This command is longer than ${MAX_ACCEPT_LINES} lines. Open the thread to answer it.`}
        </Text>
      ) : null}
      {answerableHere ? null : (
        <Text style={styles.muted}>
          This kind of approval has choices only the thread shows. Open the thread to answer it.
        </Text>
      )}
      {answerableHere && awaitingScroll && !tooLong ? (
        <Text style={styles.muted}>Scroll to the end of the command to answer here.</Text>
      ) : null}
    </>
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
