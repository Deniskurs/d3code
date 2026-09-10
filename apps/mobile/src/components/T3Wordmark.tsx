import type { ColorValue } from "react-native";
import { Image } from "expo-image";

/** Shared full-colour Devis mark, including compact navigation and work logs. */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      source={require("../../../../assets/devis/brand.png")}
      accessibilityLabel="D3 Code"
      accessibilityIgnoresInvertColors
      style={{ height: props.height, width: props.height }}
    />
  );
}
