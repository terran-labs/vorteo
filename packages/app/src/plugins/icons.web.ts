import {
  createElement,
  memo,
  useEffect,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
} from "react";
import {
  Settings,
  SquareTerminal,
  Terminal,
  Server,
  Bot,
  Folder,
  FolderOpen,
  File,
  FileText,
  GitBranch,
  GitPullRequest,
  Search,
  Bell,
  Image,
  Link,
  Paperclip,
  Clipboard,
  Code,
  Blocks,
  Palette,
  MessageSquare,
  Sparkles,
  Layers,
  BookOpen,
  Globe,
  Calendar,
  Monitor,
  Puzzle,
  Wrench,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import {
  findSvgIconProblem,
  type PluginIconProps,
  type PluginSerializableIcon,
  type PluginSvgIcon,
} from "@getpaseo/plugin";
import type { PluginIcon } from "@getpaseo/plugin/client";
import type { IconProps } from "@getpaseo/plugin/client/ui";
import { SvgIcon } from "@/components/provider-icons";
import { iconNameGroups } from "./icon-names.generated";
import { loadedCustomIcon, loadCustomIcons, useCustomIconState } from "./icon-catalog";

const common: Record<string, LucideIcon> = {
  Settings,
  SquareTerminal,
  Terminal,
  Server,
  Bot,
  Folder,
  FolderOpen,
  File,
  FileText,
  GitBranch,
  GitPullRequest,
  Search,
  Bell,
  Image,
  Link,
  Paperclip,
  Clipboard,
  Code,
  Blocks,
  Palette,
  MessageSquare,
  Sparkles,
  Layers,
  BookOpen,
  Globe,
  Calendar,
  Monitor,
  Puzzle,
  Wrench,
};
const canonicalNames = new Map<string, string>();
const commonByCanonical = new Map<string, LucideIcon>();
for (const group of iconNameGroups) {
  const names = group.split(",");
  for (const name of names) {
    canonicalNames.set(name, names[0]);
    if (common[name]) commonByCanonical.set(names[0], common[name]);
  }
}
const components = new Map<string, LucideIcon>();
/** Matches `createIconCatalog`, which refuses a fourth attempt until reload. */
const ICON_RETRY_LIMIT = 3;
function findPluginIcon(name: string): LucideIcon | null {
  const canonical = canonicalNames.get(name);
  if (!canonical) return null;
  const immediate = commonByCanonical.get(canonical);
  if (immediate) return immediate;
  const cached = components.get(canonical);
  if (cached) return cached;
  // The full catalog is a separate chunk (about 156 KB brotli, cached for a year) that only
  // loads when a plugin asks for an icon outside `common`. It is not gated on data saving: the
  // one-time cost is small and a placeholder would hide what the plugin's action is.
  const OptionalIcon: LucideIcon = memo((props: ComponentProps<LucideIcon>) => {
    const status = useCustomIconState();
    useEffect(() => {
      if (status.phase === "idle") {
        void loadCustomIcons().catch(() => undefined);
        return undefined;
      }
      // A failed download retries after 2s, then 4s, and as soon as the browser is back online,
      // within the catalog's three attempts. The catalog shares one request across icons.
      if (status.phase !== "failed" || status.attempts >= ICON_RETRY_LIMIT) return undefined;
      const retry = () => void loadCustomIcons().catch(() => undefined);
      const timer = setTimeout(retry, 2000 * 2 ** (status.attempts - 1));
      window.addEventListener("online", retry);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("online", retry);
      };
    }, [status.phase, status.attempts]);
    const icon = loadedCustomIcon(canonical);
    let fallbackLabel: string | undefined;
    if (!icon) {
      fallbackLabel = status.phase === "failed" ? "Icon unavailable" : "Icon loading";
    }
    return createElement(icon ?? Puzzle, {
      ...props,
      accessibilityLabel: props.accessibilityLabel ?? fallbackLabel,
    });
  });
  OptionalIcon.displayName = `Optional${canonical}`;
  components.set(canonical, OptionalIcon);
  return OptionalIcon;
}
export function resolvePluginIcon(name: string): LucideIcon {
  const icon = findPluginIcon(name);
  if (!icon) throw new Error(`Unknown Lucide icon: ${name}`);
  return icon;
}

/** Host surfaces may thin a Lucide stroke; SVG and plugin components ignore it. */
type HostIconProps = PluginIconProps & { strokeWidth?: number };
/** A host-drawn icon. A plain function, so it stands in for any plugin icon component type. */
type HostIcon = (props: HostIconProps) => ReactElement | null;

const lucideIconComponents = new Map<string, HostIcon>();
const svgIconComponents = new Map<string, HostIcon>();

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function isSvgIcon(icon: unknown): icon is PluginSvgIcon {
  return (
    typeof icon === "object" &&
    icon !== null &&
    !("$$typeof" in icon) &&
    typeof Reflect.get(icon, "svg") === "string"
  );
}

function isComponentIcon<Props extends PluginIconProps>(
  icon: PluginIcon<Props>,
): icon is ComponentType<Props> {
  return isComponent(icon);
}

function invalidIcon(owner: string, reason: string): Error {
  return new Error(`${owner} has an invalid icon: ${reason}`);
}

/** Validates an icon that is stored with the data it labels. Returns the normalized icon. */
export function parseSerializablePluginIcon(
  owner: string,
  icon: PluginSerializableIcon,
): PluginSerializableIcon {
  if (typeof icon === "string") {
    const name = icon.trim();
    if (!name) throw new Error(`${owner} has no icon`);
    if (!findPluginIcon(name)) throw invalidIcon(owner, `unknown Lucide icon "${name}"`);
    return name;
  }
  if (!isSvgIcon(icon)) throw invalidIcon(owner, "expected a Lucide icon name or { svg }");
  const svg = icon.svg.trim();
  const problem = findSvgIconProblem(svg);
  if (problem) throw invalidIcon(owner, problem);
  return { svg };
}

/** Validates a contribution's icon once, at registration. Rendering trusts the result. */
export function parsePluginIcon<Props extends PluginIconProps>(
  owner: string,
  icon: PluginIcon<Props>,
): PluginIcon<Props> {
  if (isComponentIcon(icon)) return icon;
  if (typeof icon !== "string" && !isSvgIcon(icon)) {
    throw invalidIcon(owner, "expected a Lucide icon name, { svg }, or a component");
  }
  return parseSerializablePluginIcon(owner, icon);
}

function MissingIcon(): null {
  return null;
}

function createLucideIcon(name: string, Lucide: LucideIcon): HostIcon {
  function PluginLucideIcon({ size, color, strokeWidth }: HostIconProps) {
    return createElement(Lucide, { size, color, strokeWidth });
  }
  PluginLucideIcon.displayName = `PluginLucideIcon(${name})`;
  return PluginLucideIcon;
}

function lucideIconComponent(name: string): HostIcon {
  const cached = lucideIconComponents.get(name);
  if (cached) return cached;
  const Lucide = findPluginIcon(name);
  if (!Lucide) return MissingIcon;
  const icon = createLucideIcon(name, Lucide);
  lucideIconComponents.set(name, icon);
  return icon;
}

function svgIconComponent(svg: string): HostIcon {
  const cached = svgIconComponents.get(svg);
  if (cached) return cached;
  function PluginSvgIcon({ size, color }: PluginIconProps) {
    return createElement(SvgIcon, { svg, size, color });
  }
  svgIconComponents.set(svg, PluginSvgIcon);
  return PluginSvgIcon;
}

/**
 * A stable component for a registered icon, for surfaces that take an icon component. Lucide and
 * SVG icons draw from `size` and `color` only; a plugin component receives every prop.
 */
export function pluginIconComponent<Props extends PluginIconProps>(
  icon: PluginIcon<Props>,
): ComponentType<Props> {
  if (typeof icon === "string") return lucideIconComponent(icon);
  if (isSvgIcon(icon)) return svgIconComponent(icon.svg);
  return icon;
}

export interface PluginIconViewProps extends PluginIconProps {
  icon: PluginIcon;
}

/** Draws a registered plugin icon. `color` tints Lucide icons and `currentColor` in SVG. */
export function PluginIconView({ icon, size, color }: PluginIconViewProps): ReactElement {
  return createElement(pluginIconComponent(icon), { size, color });
}

function isRenderable(icon: PluginIcon): boolean {
  if (typeof icon === "string") return findPluginIcon(icon) !== null;
  if (isSvgIcon(icon)) return findSvgIconProblem(icon.svg) === null;
  return isComponent(icon);
}

/** The kit `Icon`. Plugin code passes it anything, so an unusable icon renders nothing. */
export function Icon(props: IconProps): ReactElement | null {
  const icon = props.icon === undefined ? props.name : props.icon;
  if (!isRenderable(icon)) return null;
  const size = props.size ?? 24;
  const color = props.color ?? "currentColor";
  return createElement(PluginIconView, { icon, size, color });
}
