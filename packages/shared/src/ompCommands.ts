/** Leading OMP commands need the native prompt dispatcher, not raw text steering. */
export function isOmpCommandInput(text: string | undefined): boolean {
  return /^\/[^\s/]+(?:\s|$)/u.test(text?.trimStart() ?? "");
}
