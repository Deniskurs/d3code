# D3 Code releases

D3 has its own version, beginning with **0.1.0**. The desktop, bundled server, web, and mobile clients
share that version. The upstream T3 tag stays in `packages/shared/src/d3Build.ts`.
The application name is **D3 Code (Devis)**.

## First-run OMP setup

D3 probes the configured OMP executable and checks its version. For a default
installation it searches PATH, then common native, Bun, and Homebrew locations.
Existing installations keep priority. Fresh settings enable OMP detection;
explicitly disabled instances remain disabled.

The first-run Agents screen offers Install when OMP is missing. Install opens
an embedded setup terminal with the official installer prepared. Click Run setup
and follow its prompts. Close the panel to refresh detection, then choose Set up
accounts to run OMP's own account setup. No external terminal is required.

The same controls remain available in Settings > Providers > Oh My Pi > Setup.
A remote connection installs and configures OMP on the selected host, not on the
phone or browser displaying the controls. Read-only connections cannot run setup.
OMP owns its installation, accounts, profiles, and credentials. Its existing
provider update button uses the installation's supported update mechanism.

## Configure Apple signing

Add these repository Actions secrets in `Deniskurs/d3code`. Do not commit them
or paste them into chat.

| Secret                | Value                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `D3_CSC_LINK`         | Base64-encoded Developer ID Application certificate exported as a `.p12`, including its private key |
| `D3_CSC_KEY_PASSWORD` | Password used when exporting that `.p12`                                                            |
| `D3_APPLE_API_KEY`    | Contents of the App Store Connect API key `.p8` file                                                |
| `D3_APPLE_API_KEY_ID` | That API key's ID                                                                                   |
| `D3_APPLE_API_ISSUER` | That API key's issuer ID                                                                            |

The signing identity must remain compatible between releases so existing Mac
installations can verify updates. The application identifier is
`com.deniskurs.d3code`.

The D3 workflow signs and notarizes the app. It does not enable the original
T3 hosted-service passkey entitlements, which require their own domain and
provisioning setup. This is separate from signing the desktop application.

## Build and publish

After the workflow is present on the repository's default branch:

1. Run `vp run d3:version 0.1.1` for the next release, review and commit the change.
   Do not reuse a version already published. Merging a T3 update must not replace
   D3's version with the upstream package version.
2. Run **Actions > D3 Release > Run workflow** on the intended branch, with
   **signed** enabled. Keep **draft_release** off for an artifact-only verification run.
3. The workflow checks OMP/setup/update behavior, typechecks the affected packages,
   builds the Apple Silicon DMG and ZIP, verifies signing and Gatekeeper acceptance,
   and uploads artifacts. An unsigned run produces local-test artifacts without
   an update feed and cannot create a release draft.
4. When ready to stage the release, run with **draft_release** enabled. It creates
   a GitHub draft with the installers, checksums, blockmaps, and `latest-mac.yml`.
5. Review the draft, add the tested upstream T3 tag and OMP version to its notes,
   and publish it as the latest release. Publishing makes it downloadable and
   available to existing signed D3 installations.

The first release requires approval to push the local implementation and to
publish. This workflow never publishes a public release automatically. The
inherited upstream release workflow is restricted to `pingdotgg/t3code`.

## Download and update links

Once a release is published, share:

- Release page: <https://github.com/Deniskurs/d3code/releases/latest>
- Apple Silicon download: <https://github.com/Deniskurs/d3code/releases/latest/download/D3-Code-mac-arm64.dmg>

Keep the fixed download filename in every release. The versioned filenames must
also remain attached because the updater metadata refers to them. Never overwrite
published assets with a different build. Publish a new version instead.

Signed D3 builds use only `Deniskurs/d3code` as their update source. A new public
release appears through the existing Download / Restart update controls. Unsigned
local builds have no updater feed; install the first signed release manually.
OMP updates are separate provider updates and do not require a D3 release.
