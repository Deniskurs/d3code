import { tokenizeCliArgs } from "./cliArgs.ts";

export function hasBalancedCliQuotes(launchArgs: string | undefined): boolean {
  if (!launchArgs) return true;

  let quote: "'" | '"' | undefined;
  for (let index = 0; index < launchArgs.length; index++) {
    const char = launchArgs[index];
    if (char === undefined) continue;

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        index++;
      }
      continue;
    }

    if (char === "'" || char === '"') quote = char;
  }

  return quote === undefined;
}

export function ompProfileFromLaunchArgs(launchArgs: string | undefined): string | undefined {
  if (!hasBalancedCliQuotes(launchArgs)) return undefined;

  let profile: string | undefined;
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return undefined;
      if (profile !== undefined) return undefined;
      profile = value;
      index++;
      continue;
    }

    if (arg?.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (!value || value.startsWith("-")) return undefined;
      if (profile !== undefined) return undefined;
      profile = value;
    }
  }

  return profile;
}
