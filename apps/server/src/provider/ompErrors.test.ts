import { describe, expect, it } from "@effect/vitest";
import { AcpRequestError, AcpProcessExitedError } from "effect-acp/errors";
import { ompFailureDetail } from "./ompErrors.ts";

describe("OMP failure guidance", () => {
  it("uses the ACP authentication code even when its message is unfamiliar", () => {
    expect(ompFailureDetail(AcpRequestError.authRequired("Connexion requise"))).toContain(
      "Authentication required",
    );
  });
  it("preserves actual request errors instead of labeling every failure a login problem", () => {
    expect(ompFailureDetail(AcpRequestError.internalError("Rate limit exceeded"))).toBe(
      "Rate limit exceeded",
    );
    expect(ompFailureDetail(new AcpProcessExitedError({ code: 1 }))).toBe(
      "ACP process exited with code 1",
    );
  });
  it("preserves credential failure details from nonstandard upstream errors", () => {
    expect(ompFailureDetail(new Error("OAuth refresh token expired"))).toBe(
      "OAuth refresh token expired",
    );
  });
});
