import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The "D3" brand mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 580 / 432;
  return (
    <Svg
      accessibilityLabel="D3"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="225 298 580 432"
    >
      <ThemedPath
        d="M225 298H351C461 298 512 373 512 512S461 726 351 726H225V298ZM309 380V644H348C404 644 430 602 430 512S404 380 348 380H309Z M574 300H792V381L690 473C764 483 805 525 805 597C805 681 750 730 659 730C609 730 566 716 531 688L575 618C600 638 628 649 659 649C699 649 723 630 723 601C723 570 699 552 653 552H601V479L702 382H574V300Z"
        fillRule="evenodd"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
