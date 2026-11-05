import { useId } from "react";
import Svg, {
  ClipPath,
  Defs,
  LinearGradient,
  Stop,
  G,
  Path,
  Image as SvgImage,
} from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { logoPalette, type LogoPalette } from "./vorteo-logo-palette";
import { VORTEO_MARK_PATH, VORTEO_MARK_SHADING } from "./vorteo-master";

// Maps potrace's tenfold, flipped units onto the 640-unit view box.
const MARK_TRANSFORM = "translate(0 640) scale(0.1 -0.1)";

interface VorteoLogoProps {
  size?: number;
  color?: string;
}

function LogoArtwork({ size = 64, color, palette }: VorteoLogoProps & { palette: LogoPalette }) {
  const gradientId = `vorteo-${useId().replace(/:/g, "")}`;
  const clipId = `${gradientId}-silhouette`;
  // One master for every scene: a tint is a gradient whose ends match.
  const start = color ?? palette.start;
  const end = color ?? palette.end;
  return (
    <Svg width={size} height={size} viewBox="0 0 640 640" accessibilityLabel="Vorteo">
      <Defs>
        {/* User space includes the mark's flip, so this still runs top left to bottom right. */}
        <LinearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="6400"
          x2="6400"
          y2="0"
        >
          <Stop offset="0" stopColor={start} />
          <Stop offset="1" stopColor={end} />
        </LinearGradient>
        <ClipPath id={clipId}>
          <Path transform={MARK_TRANSFORM} d={VORTEO_MARK_PATH} />
        </ClipPath>
      </Defs>
      <G transform={MARK_TRANSFORM}>
        <Path d={VORTEO_MARK_PATH} fill={`url(#${gradientId})`} />
      </G>
      {/* Darkening by the master's shading equals multiplying the tint by its luminance. */}
      <SvgImage
        href={VORTEO_MARK_SHADING.uri}
        x={VORTEO_MARK_SHADING.x}
        y={VORTEO_MARK_SHADING.y}
        width={VORTEO_MARK_SHADING.width}
        height={VORTEO_MARK_SHADING.height}
        preserveAspectRatio="none"
        clipPath={`url(#${clipId})`}
      />
    </Svg>
  );
}

export const VorteoLogo = withUnistyles(LogoArtwork, (theme) => ({ palette: logoPalette(theme) }));
