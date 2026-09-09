import * as Schema from "effect/Schema";
import { AcpRequestError } from "effect-acp/errors";

const authRequiredCode = AcpRequestError.authRequired().code;

export function ompFailureDetail(cause: unknown): string {
  if (Schema.is(AcpRequestError)(cause) && cause.code === authRequiredCode) {
    return "Authentication required. Open Settings > Providers > Oh My Pi > Set up accounts, then retry.";
  }
  return cause instanceof Error
    ? cause.message
    : "Oh My Pi request failed. Check the provider connection and retry.";
}
