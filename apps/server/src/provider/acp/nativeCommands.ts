import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import type { AvailableCommand } from "effect-acp/schema";

export function nativeCommands(
  commands: ReadonlyArray<AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    const name = command.name.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      { name, ...(description ? { description } : {}), ...(hint ? { input: { hint } } : {}) },
    ];
  });
}
