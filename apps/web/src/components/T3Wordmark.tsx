import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 100 56" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="46"
        fontFamily="system-ui, sans-serif"
        fontWeight="800"
        fontSize="60"
        letterSpacing="-4"
        fill="currentColor"
      >
        D3
      </text>
    </svg>
  );
}
