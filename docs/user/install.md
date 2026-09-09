# Install D3 Code (Devis)

D3 Code is a desktop workspace for coding agents. The current published installer
supports Apple Silicon Macs (M1 or newer) and includes its server runtime.

## Install the Mac app

1. [Download D3 Code](https://github.com/Deniskurs/d3code/releases/latest/download/D3-Code-mac-arm64.dmg).
2. Open the DMG and drag **D3 Code (Devis)** into Applications.
3. Launch D3 and follow the setup screens to add your agents and projects.

The app is signed and notarized by Apple. No App Store listing is required.
Installers for Intel Macs, Windows, Linux, and mobile are not currently published
by this project.

## Set up Oh My Pi

D3 detects existing OMP installations. If OMP is missing, choose Install, open the
setup terminal, and choose Run setup. Follow the installer's prompts, then close
the panel to refresh detection. Choose Set up accounts to configure the accounts
and models you want to use.

You can return to this flow in **Settings > Providers > Oh My Pi > Setup**.
If you installed OMP in a custom location, set its **Binary path** in provider
settings. OMP continues to manage its own credentials and profiles.

When connected to another computer, provider setup runs on that computer, not on
the device displaying the interface.

## Other providers

Open **Settings > Providers** to enable and configure Codex, Claude Code, Cursor,
Grok, OpenCode, or Antigravity. Provider accounts and subscriptions are separate
from D3 Code.

## Updates

D3 checks its own release source for application updates. Use the download and
restart controls when a new release is available. If you used an earlier unsigned
D3 build, install the signed release manually once.

OMP updates are separate from D3 releases. Enable **Provider update checks** in
Settings > General and use the provider update control when an update is offered.
The available update mechanism depends on how OMP was installed.
