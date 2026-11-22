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
import { OpenQuestion, useQuestionAnswer } from "./card";
import {
  collectThreadQuestions,
  globalOpenQuestionCount,
  type QuestionHostInput,
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

export function GlobalOpenQuestionsCard({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const threads = useThreadQuestions();
  const update = useInstallationUpdate();
  const count = globalOpenQuestionCount(threads, update?.entry ?? null);
  // An update in progress shows without counting, so the card can be visible at zero.
  if (count === 0 && !update) return null;
  return (
    <GlobalCard
      kind="globalQuestions"
      title="Open questions"
      icon={HEADING_ICON}
      count={count}
      countLabel={`${count} open ${count === 1 ? "question" : "questions"}${update ? " including the installation update" : " across all threads"}`}
      testID="global-open-questions-card"
    >
      {update ? <InstallationUpdateItem {...update} /> : null}
      {threads.map((thread, index) => (
        <ThreadQuestionGroup
          key={thread.key}
          thread={thread}
          first={index === 0 && !update}
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
  const openThread = useCallback(() => {
    onBeforeNavigate?.();
    navigateToAgent({ serverId: thread.serverId, agentId: thread.agentId });
  }, [onBeforeNavigate, thread.agentId, thread.serverId]);
  const origin = [thread.projectLabel, thread.hostLabel].filter(Boolean).join(" · ");
  const context = useMemo(
    () => (
      <View style={styles.origin}>
        <View style={styles.originText}>
          <Text style={styles.thread} numberOfLines={1}>
            {thread.threadTitle}
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
          onPress={openThread}
          accessibilityLabel={`Open thread ${thread.threadTitle}`}
          testID={`global-open-question-thread-${thread.agentId}`}
        >
          Open
        </Button>
      </View>
    ),
    [openThread, origin, thread.agentId, thread.threadTitle],
  );
  return (
    <View
      style={!first && [taskCardStyles.separator, sectionDividerBleedStyle(bleed)]}
      testID={`global-open-questions-thread-${thread.agentId}`}
    >
      {thread.questions.map((question, index) => (
        <OpenQuestion
          key={question.id}
          question={question}
          tasks={thread.tasks}
          first={index === 0}
          canAnswer={canAnswer}
          pending={pendingId === question.id}
          onAnswer={answer}
          onShowTasks={openThread}
          context={index === 0 ? context : undefined}
          testIDPrefix="global-open-question"
        />
      ))}
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
