import type { SVGProps } from "react";
import brandImage from "../../../../assets/devis/brand.png";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <image href={brandImage} width="128" height="128" />
    </svg>
  );
}
