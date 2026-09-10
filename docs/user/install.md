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

## Continue OMP sessions

In an OMP chat, open **OMP sessions** in the header to browse conversations saved
for that project and provider profile. Search by title, or paste a full session
ID or `omp --resume <session-id>` command and choose **Find session** to look up
older sessions across projects in that provider profile too. D3 shows the saved
folder before you continue and adds the project if needed. Pasted commands are
used for lookup, not executed.
Select a session to preview it and continue
in D3. Reopening an imported session returns to the same chat. **Fork session**
creates a separate native OMP session and D3 chat.

To use OMP's terminal interface, choose **Continue in terminal**, then open the
D3 terminal or copy the resume command to a terminal on the connected computer.
Close OMP in that terminal when finished and choose **Refresh history** before
sending another message in D3. This adds new messages without duplicating the
conversation. If you change the native conversation branch, fork it to open that
history separately.

After OMP connects, its supported commands appear in the composer's `/` menu.
Commands that require OMP's terminal interface, including `/tree` and `/login`,
use the terminal handoff. Imported history shows conversation text; native OMP
retains its full session context, tools, and attachments.

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
