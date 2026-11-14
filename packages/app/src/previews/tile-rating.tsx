import { Star } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { CAN_HOVER, groupHoverStyle, revealOnGroupHover } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { nextRating } from "./model";

/** Hover group a preview tile declares so its rating pill can follow the whole tile. */
export const PREVIEW_TILE_HOVER_GROUP = "preview-tile";
const TILE_HOVER_GROUP = PREVIEW_TILE_HOVER_GROUP;

const ThemedStar = withUnistyles(Star);
const filledStar = (theme: Theme) => ({ color: theme.colors.accent, fill: theme.colors.accent });
const emptyStar = (theme: Theme) => ({ color: theme.colors.foregroundMuted, fill: "none" });

/**
 * The rating for one tile, laid over the bottom left of its thumbnail.
 *
 * With a mouse, the five stars appear when the tile is hovered or focused, and light up to
 * the star under the pointer. A saved rating stays visible as a small chip at rest, so a
 * gallery sorted by rating can be read without hovering.
 *
 * On a touch screen there is no hover. The chip is always shown and a tap on it opens the
 * five stars; tapping the tile itself still opens the preview. Choosing a star closes them.
 */
export function TileRating({
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
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const clearPreview = useCallback(() => setPreview(null), []);
  const rate = useCallback(
    (value: number) => {
      onRate(nextRating(rating, value));
      setOpen(false);
      setPreview(null);
    },
    [onRate, rating],
  );
  const lit = preview ?? rating ?? 0;
  const stars = (
    <View
      style={CAN_HOVER ? styles.pillOnHover : styles.pill}
      accessibilityRole="radiogroup"
      accessibilityLabel="Rating"
      testID={testID}
      onPointerLeave={clearPreview}
    >
      {[1, 2, 3, 4, 5].map((value) => (
        <StarButton
          key={value}
          value={value}
          filled={value <= lit}
          selected={rating === value}
          disabled={disabled}
          onRate={rate}
          onPreview={setPreview}
        />
      ))}
    </View>
  );
  if (CAN_HOVER) {
    return (
      <View style={styles.anchor} pointerEvents="box-none">
        {rating === null ? null : (
          <View style={styles.chipHiddenOnHover} pointerEvents="none">
            <Chip rating={rating} />
          </View>
        )}
        {stars}
      </View>
    );
  }
  return (
    <View style={styles.anchor} pointerEvents="box-none">
      {open ? (
        stars
      ) : (
        <PressHighlight
          onPress={toggle}
          disabled={disabled}
          style={styles.chipTouch}
          accessibilityRole="button"
          accessibilityLabel={
            rating === null ? "Rate this preview" : `Rated ${rating} of 5. Change`
          }
          testID={testID ? `${testID}-chip` : undefined}
        >
          <Chip rating={rating} />
        </PressHighlight>
      )}
    </View>
  );
}

function Chip({ rating }: { rating: number | null }) {
  return (
    <View style={styles.chip}>
      <ThemedStar size={14} uniProps={rating === null ? emptyStar : filledStar} />
      {rating === null ? null : <Text style={styles.chipText}>{rating}</Text>}
    </View>
  );
}

function StarButton({
  value,
  filled,
  selected,
  disabled,
  onRate,
  onPreview,
}: {
  value: number;
  filled: boolean;
  selected: boolean;
  disabled: boolean;
  onRate: (value: number) => void;
  onPreview: (value: number | null) => void;
}) {
  const press = useCallback(() => onRate(value), [onRate, value]);
  const hoverIn = useCallback(() => onPreview(value), [onPreview, value]);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  return (
    <PressHighlight
      style={CAN_HOVER ? styles.star : styles.starTouch}
      disabled={disabled}
      onPress={press}
      onHoverIn={hoverIn}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${value} ${value === 1 ? "star" : "stars"}`}
      accessibilityHint={selected ? "Clears the rating" : undefined}
    >
      <ThemedStar size={CAN_HOVER ? 16 : 20} uniProps={filled ? filledStar : emptyStar} />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => {
  const surface = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  };
  return {
    anchor: { position: "absolute", left: theme.spacing[1], bottom: theme.spacing[1] },
    pill: { ...surface },
    // Mounted but invisible and click-through until the tile is hovered or focused.
    pillOnHover: {
      ...surface,
      position: "absolute",
      left: 0,
      bottom: 0,
      paddingHorizontal: theme.spacing[1],
      ...revealOnGroupHover(TILE_HOVER_GROUP),
    },
    chip: {
      ...surface,
      gap: theme.spacing[1],
      minHeight: 24,
      paddingHorizontal: theme.spacing[2],
    },
    // The saved rating steps aside while the five stars are shown in its place.
    chipHiddenOnHover: groupHoverStyle(TILE_HOVER_GROUP, { opacity: 0 }),
    // A full 44px target around the small chip.
    chipTouch: { minWidth: 44, minHeight: 44, justifyContent: "flex-end" },
    chipText: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
    },
    star: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
    starTouch: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  };
});
