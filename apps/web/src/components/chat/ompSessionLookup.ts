import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Extract an identity for lookup only. Pasted commands are never executed. */
export function ompSessionIdFromInput(input: string): string | undefined {
  const text = input.trim();
  if (sessionIdPattern.test(text)) return text.toLowerCase();
  const args = tokenizeCliArgs(text);
  if (!/(?:^|[/\\])omp(?:\.exe)?$/i.test(args[0] ?? "")) return undefined;
  const ids = args.flatMap((arg, index) => {
    const value =
      arg === "--resume" ? args[index + 1] : arg.startsWith("--resume=") ? arg.slice(9) : undefined;
    return value && sessionIdPattern.test(value) ? [value.toLowerCase()] : [];
  });
  return ids.length === 1 ? ids[0] : undefined;
}
