import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Pure cross-platform PATH construction needs both win32 and posix joins.
import * as NodePath from "node:path";

/** Finder and existing server processes may not inherit the installer's updated PATH. */
export function withOmpSearchPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory = NodeOS.homedir(),
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const pathKey = windows
    ? (Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH")
    : "PATH";
  const join = windows ? NodePath.win32.join : NodePath.posix.join;
  const extra = windows
    ? [
        join(environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"), "omp"),
        join(homeDirectory, ".bun", "bin"),
      ]
    : [
        join(homeDirectory, ".local", "bin"),
        join(homeDirectory, ".bun", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
  const separator = windows ? ";" : ":";
  const entries = [
    ...(environment[pathKey] ?? "").split(separator).filter(Boolean),
    ...extra,
    ...(environment.PI_INSTALL_DIR ? [environment.PI_INSTALL_DIR] : []),
  ];
  return { ...environment, [pathKey]: [...new Set(entries)].join(separator) };
}
