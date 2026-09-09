# D3 Code

D3 Code is Denis's personal fork of [T3 Code](https://github.com/pingdotgg/t3code), with Oh My Pi support. The original T3 license and attribution remain in place.

The OMP integration comes from [PR 8224](https://github.com/pingdotgg/t3code/pull/8224), including Chris Watson's original commit and Thytu's follow-up work. Its commits remain in this branch's history. Newer T3 provider and interaction-mode handling is retained where it supersedes that PR.

## Local use

Install dependencies with `vp i`. Run `vp run dev --home-dir /tmp/d3-test` for a separate test environment, then open the pairing URL printed by the server. Enable Oh My Pi in Settings > Providers. OMP is installed separately; its credentials and profiles remain owned by OMP.

D3 uses `~/.d3` by default. Set `D3CODE_HOME` or pass `--home-dir` to select another location. An ambient `T3CODE_HOME` does not select D3's data. Desktop identity is `com.deniskurs.d3code`, browser storage uses the `d3code://` origin, and the display name is D3 Code. D3 does not migrate an official T3 installation's Electron profile.

The npm-backed managed background service is unavailable in this local build; keep the D3 desktop app running to host the environment.

Automatic desktop, remote server, and mobile OTA updates are disabled. Install a freshly tested D3 artifact to update. Do not use official T3 installers to update D3.

Build a local unsigned macOS artifact with `vp run dist:desktop:dmg:arm64`. Artifacts are written to `release/`. A changed bundle identifier requires separate signing and provisioning if distributing signed desktop or mobile builds.

## Updating the T3 base

`origin` is `Deniskurs/d3code`; `upstream` is `pingdotgg/t3code`. OMP 18.1.11 passed a live adapter conversation, and OMP 18.1.15 passed a browser conversation and continuation after a server restart on this initial nightly base.

The selected upstream tag is recorded in `packages/shared/src/d3Build.ts`. Nightly tags are immutable reference points for reproducing a build; do not build from a moving `main` without recording the commit.

1. Finish or commit local work. Fetch upstream tags with `git fetch upstream --tags`.
2. Select a published nightly with `gh release list --repo pingdotgg/t3code`.
3. Create a local update branch from the working D3 branch, then merge that exact tag.
4. Resolve conflicts while retaining D3's identity, isolated home settings, disabled official updaters, and OMP provider registration.
5. Update the pinned tag and desktop/server package versions. Run `vp i` if dependencies changed.
6. Run the focused OMP suites, ACP regressions, D3 identity and updater tests, and affected package typechecks. Test a real OMP conversation, approvals, cancellation and resume in isolated state.
7. Build and inspect the artifact before installing it. Record the tested T3 tag and OMP version in the release notes when publishing an authorized D3 release.

Useful focused checks:

```sh
vp test run apps/server/src/provider/Layers/OmpAdapter.test.ts apps/server/src/provider/Layers/OmpProvider.test.ts apps/server/src/provider/acp/OmpAcpSupport.test.ts apps/server/src/textGeneration/OmpTextGeneration.test.ts
vp test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/desktop/src/updates/DesktopUpdates.d3.test.ts apps/desktop/src/app/DesktopEnvironment.test.ts apps/desktop/src/electron/ElectronProtocol.test.ts
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop --filter @t3tools/mobile typecheck
```

Merges and checks can be automated locally. Conflicts or failed behavior checks require adaptation before the update is usable. Fetching and merging upstream does not publish anything; pushes and releases remain separate actions.
