import { useId, type SVGProps } from "react";
import brandMask from "../../../../assets/devis/notification.png";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const maskId = `${useId()}-devis-mark`;

  return (
    <svg {...props} viewBox="8 8 80 80" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id={maskId} x="0" y="0" width="96" height="96" maskUnits="userSpaceOnUse">
          <image href={brandMask} width="96" height="96" />
        </mask>
      </defs>
      <rect width="96" height="96" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
