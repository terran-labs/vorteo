import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

interface PlanCardProps {
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}

export function PlanCard(props: PlanCardProps) {
  // A resolution starts its own presentation state; subsequent taps stay local.
  return <PlanCardContent key={props.outcome ?? "proposed"} {...props} />;
}

function PlanCardContent({
  title,
  description,
  text,
  outcome,
  footer,
  disableOuterSpacing = false,
  testID,
}: PlanCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const labels = {
    pending: title ?? t("agentStream.permission.plan"),
    rejected: t("agentStream.permission.rejectedPlan"),
    approved: t("agentStream.permission.approvedPlan"),
    canceled: t("agentStream.permission.canceledPlan"),
  };
  const resolvedTitle = labels[outcome ?? "pending"];
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  return (
    <TaskCard
      testID={testID}
      bodyVisible={expanded || !!footer}
      style={!disableOuterSpacing && styles.outerSpacing}
    >
      <TaskCardHeader>
        <CardDisclosure
          icon={HEADING_ICON}
          title={resolvedTitle}
          expanded={expanded}
          onPress={toggleExpanded}
          testID={`${testID ?? "plan-card"}-toggle`}
        />
      </TaskCardHeader>

      {expanded ? (
        <View style={styles.body}>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <MarkdownRenderer text={text} />
        </View>
      ) : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </TaskCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerSpacing: { marginVertical: theme.spacing[3] },
  body: { gap: theme.spacing[2] },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
  },
}));

const HEADING_ICON = <TaskCardIcon kind="plan" />;
