import { StyleSheet } from "react-native-unistyles";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

/**
 * Shared settings rhythm. Rows and gaps are about a quarter tighter than the original 16 point
 * padding so more fits on a desktop screen. The 44 point minimum is a touch-target rule, so it
 * applies to the compact layout; from `md` up a row is at least one default control plus a small
 * inset, which keeps nested rows (see row-density.tsx) visibly tighter than card rows.
 */
export const TOUCH_ROW_MIN_HEIGHT = 44;

export const settingsStyles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[4],
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  sectionHeaderTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  sectionHeaderLink: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: { xs: TOUCH_ROW_MIN_HEIGHT, md: CONTROL_HEIGHTS.md.md + theme.spacing[2] * 2 },
    // The quarter-tighter padding is for desktop; touch rows keep their original padding.
    paddingVertical: { xs: theme.spacing[4], md: theme.spacing[3] },
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[3] },
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  rowError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
}));
