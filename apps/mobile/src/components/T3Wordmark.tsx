import type { ColorValue } from "react-native";
import { Image } from "expo-image";
import { withUniwind } from "uniwind";

const ThemedImage = withUniwind(Image, {
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

/** Theme-coloured Devis silhouette for compact navigation and work logs. */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedImage
      source={require("../../../../assets/devis/notification.png")}
      accessibilityLabel="D3 Code"
      accessibilityIgnoresInvertColors
      tintColor={props.color === undefined ? undefined : String(props.color)}
      tintColorClassName={props.colorClassName ?? (props.color ? undefined : "accent-icon")}
      style={{ height: props.height, width: props.height }}
    />
  );
}
