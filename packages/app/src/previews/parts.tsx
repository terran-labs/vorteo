import type { PreviewKind, PreviewVersion } from "@getpaseo/protocol/previews";
import {
  CircleCheck,
  FileText,
  Globe,
  Image as ImageIcon,
  Link2,
  Presentation,
  Star,
} from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Image, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { nextRating, placeholderReason, thumbnailUrl } from "./model";

const KIND_ICONS = {
  web: withUnistyles(Globe),
  deck: withUnistyles(Presentation),
  image: withUnistyles(ImageIcon),
  pdf: withUnistyles(FileText),
  url: withUnistyles(Link2),
} satisfies Record<PreviewKind, unknown>;

const KIND_LABELS: Record<PreviewKind, string> = {
  web: "Web page",
  deck: "Slides",
  image: "Image",
  pdf: "PDF",
  url: "Live page",
};

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** A version's thumbnail, or its kind icon when there is none or no HTTP route to fetch it. */
export function PreviewThumb({
  version,
  httpBase,
  style,
}: {
  version: PreviewVersion;
  httpBase: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const source = useMemo(
    () => (version.hasThumbnail && httpBase ? { uri: thumbnailUrl(httpBase, version.id) } : null),
    [httpBase, version.hasThumbnail, version.id],
  );
  if (source) {
    return (
      <View style={[styles.thumb, style]}>
        <Image
          source={source}
          style={styles.thumbImage}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
          accessibilityLabel={`${version.title} thumbnail`}
        />
      </View>
    );
  }
  const Icon = KIND_ICONS[version.kind];
  return (
    <View
      style={[styles.thumb, styles.placeholder, style]}
      accessibilityLabel={KIND_LABELS[version.kind]}
    >
      <Icon size={28} uniProps={mutedIcon} />
      <Text style={styles.placeholderText} numberOfLines={1}>
        {placeholderReason(version)}
      </Text>
    </View>
  );
}

export function kindLabel(kind: PreviewKind): string {
  return KIND_LABELS[kind];
}

const ThemedStar = withUnistyles(Star);
const filledStar = (theme: Theme) => ({ color: theme.colors.accent, fill: theme.colors.accent });
const emptyStar = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted, fill: "none" });

/** One to five stars. Tapping the current rating clears it. */
export function StarRating({
  rating,
  disabled,
  onRate,
  testID,
}: {
  rating: number | null;
  disabled: boolean;
  onRate: (rating: number | null) => void;
  testID?: string;
}) {
  return (
    <View
      style={styles.stars}
      accessibilityRole="radiogroup"
      accessibilityLabel="Rating"
      testID={testID}
    >
      {[1, 2, 3, 4, 5].map((value) => (
        <StarButton
          key={value}
          value={value}
          filled={rating !== null && value <= rating}
          rating={rating}
          disabled={disabled}
          onRate={onRate}
        />
      ))}
    </View>
  );
}

function StarButton({
  value,
  filled,
  rating,
  disabled,
  onRate,
}: {
  value: number;
  filled: boolean;
  rating: number | null;
  disabled: boolean;
  onRate: (rating: number | null) => void;
}) {
  const selected = rating === value;
  const handlePress = useCallback(() => onRate(nextRating(rating, value)), [onRate, rating, value]);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  return (
    <PressHighlight
      style={styles.star}
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${value} ${value === 1 ? "star" : "stars"}`}
      accessibilityHint={selected ? "Clears the rating" : undefined}
    >
      <ThemedStar size={18} uniProps={filled ? filledStar : emptyStar} />
    </PressHighlight>
  );
}

const ThemedCheck = withUnistyles(CircleCheck);
const accentIcon = (theme: Theme) => ({ color: theme.colors.accent });

export function ApprovedMark() {
  return (
    <View style={styles.approved}>
      <ThemedCheck size={14} uniProps={accentIcon} />
      <Text style={styles.approvedText}>Approved</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  thumb: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  thumbImage: { width: "100%", height: "100%" },
  placeholder: { alignItems: "center", justifyContent: "center", gap: theme.spacing[1] },
  placeholderText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  stars: { flexDirection: "row", alignItems: "center" },
  // Each star is a full 44px target; the glyph stays small.
  star: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  approved: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  approvedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
