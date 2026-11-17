import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";

const PageScrollView = Platform.OS === "android" ? KeyboardAwareScrollView : ScrollView;

interface PageLayoutProps {
  title?: string;
  titleContent?: ReactNode;
  /** Let horizontal working surfaces reach the page viewport. */
  fullWidth?: boolean;
  /** Compact back button. Defaults to navigating back. */
  onBack?: () => void;
  testID?: string;
  titleTestID?: string;
  /** Controls for the whole page: right of the title on desktop, in the back header on compact. */
  actions?: ReactNode;
  /** Persistent controls above the scrolling content column. */
  fixedHeader?: ReactNode;
  /** A working surface, such as a dashboard: widens the column from 720 to 1440. */
  wide?: boolean;
  /**
   * Put the title and actions in the screen header, as History does, instead of a document
   * heading inside the page. The content then starts right under the header's border.
   */
  headerTitle?: boolean;
  children: ReactNode;
}

/**
 * A full-width page with a centered content column. On desktop the title is a
 * document heading inside the page and the header only keeps the titlebar drag
 * region and window controls; on compact the title moves into a back header.
 */
export function PageLayout({
  title,
  titleContent,
  fullWidth = false,
  onBack,
  testID,
  titleTestID,
  actions,
  fixedHeader,
  wide = false,
  headerTitle = false,
  children,
}: PageLayoutProps) {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const showTitle = !isCompact && !headerTitle && title !== undefined;
  let header = <MenuHeader borderless />;
  if (isCompact) {
    header = (
      <BackHeader
        title={title}
        titleContent={titleContent}
        onBack={onBack}
        rightContent={actions}
      />
    );
  } else if (headerTitle) {
    header = <MenuHeader title={title} titleContent={titleContent} rightContent={actions} />;
  }

  return (
    <View style={styles.container}>
      {header}
      {fixedHeader ? (
        <View style={[styles.fixedHeader, wide && styles.wide]}>{fixedHeader}</View>
      ) : null}
      <PageScrollView
        // Leave room for field borders and padding around the focused native input.
        {...(Platform.OS === "android" ? { bottomOffset: SPACING[4] } : {})}
        style={styles.scroll}
        contentContainerStyle={scrollContentStyle}
        testID={testID}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.content,
            wide && styles.wide,
            fullWidth && styles.fullWidth,
            headerTitle && styles.headerTitled,
          ]}
        >
          {showTitle ? (
            <View style={styles.titleRow} testID={titleTestID}>
              <Text style={styles.title} testID="page-title">
                {title}
              </Text>
              {actions}
            </View>
          ) : null}
          {children}
        </View>
      </PageScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  fixedHeader: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  headerTitled: {
    paddingTop: theme.spacing[4],
  },
  fullWidth: { maxWidth: "100%" },
  wide: {
    maxWidth: 1440,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    marginBottom: theme.spacing[6],
  },
  title: {
    // Line up with the section titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
