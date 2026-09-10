import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { nextVersion, planSync, prepareCandidate } from "./d3-upstream-sync.mjs";

const oldTag = "v0.0.41-nightly.20260909.1439";
const newTag = "v0.0.41-nightly.20260909.1461";
const release = (tag_name, published_at = "2026-09-08T10:00:00Z") => ({
  tag_name,
  published_at,
  draft: false,
  prerelease: tag_name.includes("nightly"),
});
const input = {
  currentTag: oldTag,
  currentVersion: "0.1.3",
  upstreamReleases: [release(oldTag), release(newTag)],
  releases: [release("v0.1.3")],
  now: Date.parse("2026-09-10T10:00:00Z"),
};

NodeTest.test("checks release order, no-op behavior, and daily publication limit", () => {
  NodeAssert.deepEqual(planSync(input), { tag: newTag, version: "0.1.4" });
  NodeAssert.match(planSync({ ...input, currentTag: newTag }).reason, /newest/);
  const recent = { ...input, releases: [release("v0.1.3", "2026-09-10T09:00:00Z")] };
  NodeAssert.match(planSync(recent).reason, /Daily/);
  NodeAssert.equal(planSync({ ...recent, checkOnly: true }).version, "0.1.4");
  NodeAssert.equal(
    nextVersion("0.1.3", [release("v0.1.9"), { ...release("v0.1.99"), draft: true }]),
    "0.1.10",
  );
});
NodeTest.test(
  "retries an unpublished promoted version instead of skipping it or allocating another",
  () => {
    NodeAssert.deepEqual(
      planSync({
        ...input,
        currentTag: newTag,
        currentVersion: "0.1.4",
        releases: [...input.releases, { ...release("v0.1.4"), draft: true }],
      }),
      { tag: newTag, version: "0.1.4", resume: true },
    );
  },
);

function fixture(t) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "d3-sync-test-"));
  t.after(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, value) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, file), value);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.hooksPath", "/dev/null");
  for (const app of ["desktop", "server", "web", "mobile"])
    write(
      `apps/${app}/package.json`,
      JSON.stringify({ name: app, version: "0.0.41" }, null, 2) + "\n",
    );
  write(".github/workflows/release.yml", "upstream original\n");
  write("feature.txt", "original\n");
  git("add", ".");
  git("commit", "-m", "upstream base");
  git("tag", oldTag);
  git("checkout", "-b", "upstream");
  write("new-feature.txt", "nightly feature\n");
  write(".github/workflows/release.yml", "upstream changed\n");
  git("add", ".");
  git("commit", "-m", "nightly");
  git("tag", newTag);
  git("checkout", "main");
  write(
    "packages/shared/src/d3Build.ts",
    `export const d3Build = { upstreamTag: "${oldTag}", repository: "Deniskurs/d3code" };\n`,
  );
  write(".github/workflows/release.yml", "D3 workflow\n");
  for (const app of ["desktop", "server", "web", "mobile"])
    write(
      `apps/${app}/package.json`,
      JSON.stringify({ name: app, version: "0.1.3" }, null, 2) + "\n",
    );
  git("add", ".");
  git("commit", "-m", "D3 changes");
  return { cwd, git, write };
}

NodeTest.test(
  "merges source, retains D3 automation, stamps all versions, and makes a transferable bundle",
  (t) => {
    const { cwd, git } = fixture(t);
    const bundlePath = NodePath.join(
      NodeOS.tmpdir(),
      `d3-candidate-${NodePath.basename(cwd)}.bundle`,
    );
    t.after(() => NodeFS.rmSync(bundlePath, { force: true }));
    const result = prepareCandidate({
      cwd,
      upstreamRef: newTag,
      tag: newTag,
      version: "0.1.4",
      bundlePath,
    });
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, "new-feature.txt"), "utf8"),
      "nightly feature\n",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, ".github/workflows/release.yml"), "utf8"),
      "D3 workflow\n",
    );
    for (const app of ["desktop", "server", "web", "mobile"])
      NodeAssert.equal(
        JSON.parse(NodeFS.readFileSync(NodePath.join(cwd, `apps/${app}/package.json`))).version,
        "0.1.4",
      );
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(cwd, "packages/shared/src/d3Build.ts"), "utf8"),
      /Deniskurs\/d3code/,
    );
    NodeAssert.equal(git("rev-parse", "HEAD"), result.sha);
    git("bundle", "verify", bundlePath);
    NodeAssert.equal(git("status", "--porcelain"), "");
  },
);

NodeTest.test("source conflicts stop the merge without losing D3 changes", (t) => {
  const { cwd, git, write } = fixture(t);
  write("feature.txt", "D3 implementation\n");
  git("add", ".");
  git("commit", "-m", "D3 feature");
  const before = git("rev-parse", "HEAD");
  git("checkout", "upstream");
  write("feature.txt", "new upstream implementation\n");
  git("add", ".");
  git("commit", "-m", "conflicting nightly");
  git("checkout", "main");
  NodeAssert.throws(
    () =>
      prepareCandidate({
        cwd,
        upstreamRef: "upstream",
        tag: newTag,
        version: "0.1.4",
        bundlePath: NodePath.join(cwd, "unused.bundle"),
      }),
    /paused[\s\S]*feature.txt/,
  );
  NodeAssert.equal(git("rev-parse", "HEAD"), before);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, "feature.txt"), "utf8"),
    "D3 implementation\n",
  );
  NodeAssert.equal(git("status", "--porcelain"), "");
});
