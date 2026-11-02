import { Stack } from "expo-router";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";

type NativeStackNavigationOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack>["screenOptions"]>,
  (...args: never[]) => unknown
>;

interface ThemedStackBaseProps {
  backgroundColor: string;
  children?: ReactNode;
  screenOptions?: NativeStackNavigationOptions;
  // Screens whose content is another navigator. That navigator owns its own screens' appearance
  // boundary; wrapping it here would remount it.
  nestedNavigatorScreens?: readonly string[];
  /** Screens with retained lifetime owners update appearance at their own leaves. */
  screenOwnedAppearance?: readonly string[];
}

function ThemedStackBase({ backgroundColor, children, screenOptions }: ThemedStackBaseProps) {
  const themedScreenOptions = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...screenOptions,
      contentStyle: [{ backgroundColor }, screenOptions?.contentStyle],
    }),
    [backgroundColor, screenOptions],
  );
  return <Stack screenOptions={themedScreenOptions}>{children}</Stack>;
}

export const ThemedStack = withUnistyles(ThemedStackBase, (theme) => ({
  backgroundColor: theme.colors.surface0,
}));
