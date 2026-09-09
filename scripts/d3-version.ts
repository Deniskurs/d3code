// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone artifact tooling uses Node file APIs without a server runtime.
import * as NodeFSP from "node:fs/promises";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("Usage: vp run d3:version <major.minor.patch>");
}
const packages = [
  "../apps/desktop/package.json",
  "../apps/server/package.json",
  "../apps/web/package.json",
  "../apps/mobile/package.json",
];
const documents = await Promise.all(
  packages.map(async (file) => {
    const path = new URL(file, import.meta.url);
    const document = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    return { path, document: { ...document, version } };
  }),
);
for (const { path, document } of documents) {
  await NodeFSP.writeFile(path, JSON.stringify(document, null, 2) + "\n");
}
console.log(`D3 package versions set to ${version}. Upstream base unchanged.`);
