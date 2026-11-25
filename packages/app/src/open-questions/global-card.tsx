import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { taskCardStyles } from "@/agent-stream/task-card-styles";
import {
  GlobalCard,
  sectionDividerBleedStyle,
  useSectionDividerBleed,
} from "@/components/sidebar/global-card-shell";
import { Button } from "@/components/ui/button";
import { selectPendingArchiveAgentIds, usePendingArchiveState } from "@/hooks/use-archive-agent";
import { useHosts } from "@/runtime/host-runtime";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import { openConversationTarget } from "./conversation-target";
import { OpenQuestion, useQuestionAnswer } from "./card";
import { ApprovalItem } from "./approval-item";
import {
  collectThreadApprovals,
  collectThreadQuestions,
  globalOpenQuestionCount,
  type QuestionHostInput,
  type ThreadApproval,
  type ThreadQuestions,
} from "./global-model";
import { InstallationUpdateItem, useInstallationUpdate } from "./installation-update";

const HEADING_ICON = <TaskCardIcon kind="question" />;

type SessionState = ReturnType<typeof useSessionStore.getState>;
type HostSession = NonNullable<SessionState["sessions"][string]>;
/** Per question-enabled host: its id, agents and workspaces, flattened for a shallow compare. */
type HostQuestionSources = Array<string | HostSession["agents"] | HostSession["workspaces"]>;

// Stream events rewrite the session store many times a second without touching agents or
// workspaces, so the card selects only those maps; an unchanged list keeps the card still.
function selectQuestionSources(state: SessionState): HostQuestionSources {
  const sources: HostQuestionSources = [];
  for (const [serverId, session] of Object.entries(state.sessions)) {
    if (!session?.serverInfo?.features?.agentQuestions) continue;
    sources.push(serverId, session.agents, session.workspaces);
  }
  return sources;
}

/** Every thread's waiting questions on every connected host, answerable without opening it. */
function useThreadQuestions(): ThreadQuestions[] {
  const sources = useSessionStore(useShallow(selectQuestionSources));
  const hosts = useHosts();
  const pending = usePendingArchiveState();
  return useMemo(() => {
    const labels = new Map(hosts.map((host) => [host.serverId, host.label]));
    const inputs: QuestionHostInput[] = [];
    for (let index = 0; index < sources.length; index += 3) {
      const serverId = sources[index] as string;
      inputs.push({
        serverId,
        hostLabel: labels.get(serverId) ?? serverId,
        agents: (sources[index + 1] as HostSession["agents"]).values(),
        workspaces: sources[index + 2] as HostSession["workspaces"],
        pendingArchive: selectPendingArchiveAgentIds(pending, serverId),
      });
    }
    return collectThreadQuestions(inputs);
  }, [hosts, pending, sources]);
}

// Hosts that record who created each thread; only their approvals can be routed to the owner.
function selectApprovalSources(state: SessionState): HostQuestionSources {
  const sources: HostQuestionSources = [];
  for (const [serverId, session] of Object.entries(state.sessions)) {
    if (!session?.serverInfo?.features?.agentCreatedBy) continue;
    sources.push(serverId, session.agents, session.workspaces);
  }
  return sources;
}

/** Tool approvals no supervising thread can answer, on every connected host (#659). */
function useThreadApprovals(): ThreadApproval[] {
  const sources = useSessionStore(useShallow(selectApprovalSources));
  const hosts = useHosts();
  const pending = usePendingArchiveState();
  return useMemo(() => {
    const labels = new Map(hosts.map((host) => [host.serverId, host.label]));
    const inputs: QuestionHostInput[] = [];
    for (let index = 0; index < sources.length; index += 3) {
      const serverId = sources[index] as string;
      inputs.push({
        serverId,
        hostLabel: labels.get(serverId) ?? serverId,
        agents: (sources[index + 1] as HostSession["agents"]).values(),
        workspaces: sources[index + 2] as HostSession["workspaces"],
        pendingArchive: selectPendingArchiveAgentIds(pending, serverId),
        approvalsSupported: true,
      });
    }
    return collectThreadApprovals(inputs);
  }, [hosts, pending, sources]);
}

export function GlobalOpenQuestionsCard({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const threads = useThreadQuestions();
  const approvals = useThreadApprovals();
  const update = useInstallationUpdate();
  const count = globalOpenQuestionCount(threads, update?.entry ?? null, approvals);
  // An update in progress shows without counting, so the card can be visible at zero.
  if (count === 0 && !update) return null;
  return (
    <GlobalCard
      kind="globalQuestions"
      title="Open questions"
      icon={HEADING_ICON}
      count={count}
      countLabel={
        approvals.length > 0
          ? `${count} open questions and approvals across all threads`
          : `${count} open ${count === 1 ? "question" : "questions"}${update ? " including the installation update" : " across all threads"}`
      }
      testID="global-open-questions-card"
    >
      {update ? <InstallationUpdateItem {...update} /> : null}
      {approvals.map((approval, index) => (
        <ApprovalItem
          key={approval.key}
          approval={approval}
          first={index === 0 && !update}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
      {threads.map((thread, index) => (
        <ThreadQuestionGroup
          key={thread.key}
          thread={thread}
          first={index === 0 && !update && approvals.length === 0}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
    </GlobalCard>
  );
}

function ThreadQuestionGroup({
  thread,
  first,
  onBeforeNavigate,
}: {
  thread: ThreadQuestions;
  first: boolean;
  onBeforeNavigate?: () => void;
}) {
  const bleed = useSectionDividerBleed();
  const { canAnswer, pendingId, answer } = useQuestionAnswer(
    thread.serverId,
    thread.agentId,
    false,
  );
  const showTasks = useCallback(() => {
    onBeforeNavigate?.();
    navigateToAgent({ serverId: thread.serverId, agentId: thread.agentId });
  }, [onBeforeNavigate, thread.agentId, thread.serverId]);
  // Each question opens its thread where it was asked, not at the latest message (#660).
  const openQuestion = useCallback(
    (question: AgentQuestion) => {
      onBeforeNavigate?.();
      openConversationTarget(
        {
          serverId: thread.serverId,
          agentId: thread.agentId,
          kind: "question",
          id: question.id,
          seq: question.askedSeq ?? null,
          epoch: question.askedEpoch ?? null,
        },
        navigateToAgent,
      );
    },
    [onBeforeNavigate, thread.agentId, thread.serverId],
  );
  const origin = [thread.projectLabel, thread.hostLabel].filter(Boolean).join(" · ");
  return (
    <View
      style={!first && [taskCardStyles.separator, sectionDividerBleedStyle(bleed)]}
      testID={`global-open-questions-thread-${thread.agentId}`}
    >
      {thread.questions.map((question, index) => (
        <GlobalQuestion
          key={question.id}
          question={question}
          tasks={thread.tasks}
          first={index === 0}
          canAnswer={canAnswer}
          pending={pendingId === question.id}
          onAnswer={answer}
          onShowTasks={showTasks}
          threadTitle={thread.threadTitle}
          origin={index === 0 ? origin : ""}
          onOpen={openQuestion}
        />
      ))}
    </View>
  );
}

/** One question in the global card, with its thread and its own "Open". */
function GlobalQuestion({
  threadTitle,
  origin,
  onOpen,
  ...props
}: Omit<Parameters<typeof OpenQuestion>[0], "context" | "testIDPrefix"> & {
  threadTitle: string;
  origin: string;
  onOpen: (question: AgentQuestion) => void;
}) {
  const context = useMemo(
    () => (
      <QuestionContext
        question={props.question}
        threadTitle={threadTitle}
        origin={origin}
        onOpen={onOpen}
      />
    ),
    [onOpen, origin, props.question, threadTitle],
  );
  return <OpenQuestion {...props} context={context} testIDPrefix="global-open-question" />;
}

/** The thread a question came from, and "Open", which lands on that question in the thread. */
function QuestionContext({
  question,
  threadTitle,
  origin,
  onOpen,
}: {
  question: AgentQuestion;
  threadTitle: string;
  origin: string;
  onOpen: (question: AgentQuestion) => void;
}) {
  const open = useCallback(() => onOpen(question), [onOpen, question]);
  return (
    <View style={styles.origin}>
      <View style={styles.originText}>
        <Text style={styles.thread} numberOfLines={1}>
          {threadTitle}
        </Text>
        {origin ? (
          <Text style={styles.project} numberOfLines={1}>
            {origin}
          </Text>
        ) : null}
      </View>
      <Button
        variant="ghost"
        size="md"
        leftIcon={ArrowUpRight}
        onPress={open}
        accessibilityLabel={`Open this question in ${threadTitle}`}
        testID={`global-open-question-open-${question.id}`}
      >
        Open
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  origin: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  originText: { flex: 1, minWidth: 0 },
  thread: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  project: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.base },
}));
