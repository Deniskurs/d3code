import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const upstreamRepository = "pingdotgg/t3code";
const repository = "Deniskurs/d3code";
const buildFile = "packages/shared/src/d3Build.ts";
const packageFiles = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
];
const nightlyPattern = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compareVersions = (a, b) => a.localeCompare(b, "en", { numeric: true });

export function nextVersion(current, releases) {
  if (!versionPattern.test(current)) throw new Error("Invalid D3 version");
  const versions = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => r.tag_name.replace(/^v/, ""))
    .filter((v) => versionPattern.test(v));
  const latest = [current, ...versions].sort(compareVersions).at(-1);
  const [major, minor, patch] = latest.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

export function planSync({
  currentTag,
  currentVersion,
  upstreamReleases,
  releases,
  now = Date.now(),
  checkOnly = false,
}) {
  const publicReleases = releases.filter(
    (r) => !r.draft && !r.prerelease && versionPattern.test(r.tag_name.replace(/^v/, "")),
  );
  const nightly = upstreamReleases
    .filter((r) => !r.draft && r.published_at && nightlyPattern.test(r.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  const unreleased =
    versionPattern.test(currentVersion) &&
    !publicReleases.some((r) => r.tag_name === `v${currentVersion}`) &&
    publicReleases.every((r) => compareVersions(r.tag_name.slice(1), currentVersion) < 0);
  if (!unreleased && (!nightly || compareVersions(nightly.tag_name, currentTag) <= 0))
    return { reason: "Already on the newest published nightly." };
  const published = publicReleases
    .filter((r) => r.published_at)
    .map((r) => Date.parse(r.published_at));
  const latestPublication = Math.max(0, ...published);
  if (!checkOnly && now - latestPublication < 24 * 60 * 60 * 1000)
    return { reason: "Daily release limit: the last Devis release was less than 24 hours ago." };
  if (unreleased) return { tag: currentTag, version: currentVersion, resume: true };
  return { tag: nightly.tag_name, version: nextVersion(currentVersion, releases) };
}

const run = (command, args, cwd) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const git = (args, cwd) => run("git", args, cwd);

/** The merge happens in a disposable checkout. Conflicts never modify the public branch. */
export function prepareCandidate({ cwd, upstreamRef, tag, version, bundlePath }) {
  if (!nightlyPattern.test(tag) || !versionPattern.test(version))
    throw new Error("Invalid release identity");
  if (git(["status", "--porcelain"], cwd)) throw new Error("Candidate checkout must be clean");
  const baseSha = git(["rev-parse", "HEAD"], cwd);
  const originalBuild = NodeFS.readFileSync(NodePath.join(cwd, buildFile), "utf8");
  const currentTag = /upstreamTag:\s*"([^"]+)"/.exec(originalBuild)?.[1];
  if (!currentTag) throw new Error("Missing D3 upstream identity");
  const previousSha = git(["rev-parse", `${currentTag}^{commit}`], cwd);
  git(["merge-base", "--is-ancestor", previousSha, upstreamRef], cwd);
  let merged = true;
  try {
    git(["merge", "--no-commit", "--no-ff", upstreamRef], cwd);
  } catch {
    merged = false;
  }
  // D3 owns its automation. Upstream workflow changes need a maintainer review.
  git(["restore", "--source", baseSha, "--staged", "--worktree", "--", ".github/workflows"], cwd);
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], cwd);
  if (
    conflicts ||
    (!merged &&
      !NodeFS.existsSync(
        NodePath.join(git(["rev-parse", "--absolute-git-dir"], cwd), "MERGE_HEAD"),
      ))
  ) {
    try {
      git(["merge", "--abort"], cwd);
    } catch {}
    throw new Error(
      `Nightly sync paused. Resolve the upstream merge before retrying.\n${conflicts}`,
    );
  }
  for (const file of packageFiles) {
    const fullPath = NodePath.join(cwd, file);
    const pkg = JSON.parse(NodeFS.readFileSync(fullPath, "utf8"));
    pkg.version = version;
    NodeFS.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  // These D3-only settings must survive every upstream update.
  NodeFS.writeFileSync(
    NodePath.join(cwd, buildFile),
    originalBuild.replace(/upstreamTag:\s*"[^"]+"/, `upstreamTag: "${tag}"`),
  );
  git(["add", "--all"], cwd);
  git(["commit", "-m", `chore(d3): sync ${tag} for Devis ${version}`], cwd);
  const sha = git(["rev-parse", "HEAD"], cwd);
  git(["bundle", "create", bundlePath, "HEAD", `^${baseSha}`], cwd);
  return { baseSha, sha, version, tag };
}

export function releaseNotes(version, tag, subjects = []) {
  const changes = subjects.flatMap((subject) => {
    const match = /^(feat|fix)(?:\(([^)]+)\))?!?: (.+)$/.exec(subject);
    if (!match || ["ci", "build", "deps", "test"].includes(match[2])) return [];
    return [match[3][0].toUpperCase() + match[3].slice(1)];
  });
  const items = [
    ...new Set([
      `Updated to upstream nightly ${tag}, with D3 branding and OMP integration retained.`,
      ...changes,
    ]),
  ];
  return `## What's changed\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n## Full changelog\n\n[All D3 releases](https://github.com/Deniskurs/d3code/releases)\n\nD3 Code ${version} (Devis) for Apple Silicon Macs. Download D3-Code-mac-arm64.dmg and drag D3 Code (Devis) into Applications. Existing signed installations can use Check for updates on the Devis track.\n\nThis release passed D3's automated tests, package typechecks, icon checks, signing, notarization, and Gatekeeper verification.\n`;
}

export function main() {
  if (process.env.GITHUB_REPOSITORY !== repository)
    throw new Error("Nightly sync is restricted to the D3 repository");
  const cwd = process.cwd();
  const build = NodeFS.readFileSync(buildFile, "utf8");
  const currentTag = /upstreamTag:\s*"([^"]+)"/.exec(build)?.[1];
  if (!currentTag || !nightlyPattern.test(currentTag))
    throw new Error("Invalid recorded upstream nightly");
  const currentVersion = JSON.parse(NodeFS.readFileSync(packageFiles[0], "utf8")).version;
  const releases = JSON.parse(run("gh", ["api", `repos/${repository}/releases?per_page=100`]));
  const upstreamReleases = JSON.parse(
    run("gh", ["api", `repos/${upstreamRepository}/releases?per_page=30`]),
  );
  const plan = planSync({
    currentTag,
    currentVersion,
    releases,
    upstreamReleases,
    checkOnly: process.env.D3_CHECK_ONLY === "true",
  });
  const output = (values) => {
    if (process.env.GITHUB_OUTPUT)
      NodeFS.appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(""),
      );
  };
  const summary = (message) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + "\n");
  };
  if (plan.reason) {
    output({ ready: "false" });
    summary(plan.reason);
    return;
  }
  git(["config", "user.name", "D3 release automation"], cwd);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], cwd);
  git(["config", "core.hooksPath", "/dev/null"], cwd);
  git(
    [
      "fetch",
      "--no-tags",
      `https://github.com/${upstreamRepository}.git`,
      `refs/tags/${currentTag}:refs/tags/${currentTag}`,
      `refs/tags/${plan.tag}:refs/tags/${plan.tag}`,
    ],
    cwd,
  );
  const upstreamRef = git(["rev-parse", `${plan.tag}^{commit}`], cwd);
  const artifactDirectory = process.env.D3_CANDIDATE_DIR;
  if (!artifactDirectory) throw new Error("Missing candidate artifact directory");
  NodeFS.mkdirSync(artifactDirectory, { recursive: true });
  try {
    const bundlePath = NodePath.join(artifactDirectory, "candidate.bundle");
    let result;
    if (plan.resume) {
      const sha = git(["rev-parse", "HEAD"], cwd);
      git(["bundle", "create", bundlePath, "HEAD", "^HEAD~1"], cwd);
      result = { baseSha: sha, sha, version: plan.version, tag: plan.tag };
    } else result = prepareCandidate({ cwd, upstreamRef, ...plan, bundlePath });
    const previousRelease = releases
      .filter(
        (release) =>
          !release.draft &&
          !release.prerelease &&
          versionPattern.test(release.tag_name.slice(1)) &&
          compareVersions(release.tag_name.slice(1), result.version) < 0,
      )
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    const subjects = previousRelease
      ? git(
          [
            "log",
            "--first-parent",
            "--reverse",
            "--format=%s",
            `${previousRelease.tag_name}..${result.sha}`,
          ],
          cwd,
        ).split("\n")
      : [];
    NodeFS.writeFileSync(
      NodePath.join(artifactDirectory, "release-notes.md"),
      releaseNotes(result.version, result.tag, subjects),
    );
    output({
      ready: "true",
      base_sha: result.baseSha,
      source_sha: result.sha,
      version: result.version,
    });
    summary(
      `Prepared Devis ${result.version} from ${result.tag}. Public code and releases are unchanged until all release checks pass.`,
    );
  } catch (error) {
    summary(error.message);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) main();
