# Oh My Pi

D3 Code includes Oh My Pi (OMP) as an enabled provider. OMP connects your coding workspace to model subscriptions and API accounts.

## Set up your account

During first-run setup, D3 checks whether OMP is installed. Choose **Install** if it is missing. If it is already installed, choose **Set up accounts** to connect a subscription or API key and select your default model.

The setup terminal opens in a large dialog. Choose **Run setup**, follow OMP's prompts, then **Close and check**. You can reopen it from **Settings > Providers > Oh My Pi** at any time. Named OMP profiles use their own account setup.

An available model catalog does not guarantee that an old subscription login is still valid. If OMP reports an expired login, reopen **Set up accounts**, sign in again, close the panel, and retry your message.

Use **Check for updates** in the provider settings to keep OMP current. D3's application updates and OMP's runtime updates are separate.

## Queue a follow-up

The web and desktop composer [queues follow-ups in the conversation](composer.md#send-while-the-agent-is-working) while OMP is working. One message is sent after the next tool call finishes, or when the turn ends. Choose **Send now** on a queued message to steer sooner. OMP applies those instructions at its next message or tool boundary, without stopping the current model response instantly.

Other clients default to steering when sending to a running OMP session. If an OMP installation cannot load D3's steering extension, messages fall back to waiting for the current turn.

Native OMP slash commands use OMP's command dispatcher, not text steering.
If OMP is busy, they wait for the current response to finish; **Run when idle**
does not interrupt it. Ordinary follow-ups still use tool-boundary delivery.
Commands requiring OMP's terminal UI, such as `/tree` and `/login`, remain
available through **OMP sessions → Continue in terminal**.

## Resume a conversation

Open the same D3 thread and send your next message. D3 saves the OMP session reference with that thread. After D3 or its server restarts, it loads that OMP session again using the saved workspace and provider instance. You do not need to copy the resume command printed by OMP's terminal UI.

OMP owns the underlying session files. Keep the same OMP profile and its session data when continuing a thread. If that data is missing or the saved reference is invalid, resuming reports an error; the visible D3 history remains available. Create a new thread when you want a fresh session.

Browse and continue terminal conversations from **OMP sessions**. See [Continue OMP sessions](install.md#continue-omp-sessions) for native commands, terminal handoff, and automatic return to chat.

## Live output

OMP follows **Settings → General → Behavior → Response streaming**, including
project overrides. Choose finished paragraphs and code blocks, the full response,
or token-by-token delivery. This changes how replies appear, not how deeply the
model reasons.

The live activity row shows reported tool intent or a bounded native thinking
preview. **Waiting for response** means the provider is still running without
reported live activity; a completed tool is not shown as still running. Expand
**Thought process** to inspect the preview. When thinking history is available,
open it to load earlier text in pages without expanding the live stream.

New thinking history is retained by the connected environment and remains
available after a server restart. Only text actually emitted by OMP is recorded;
thinking availability depends on the selected model and provider. Text discarded
by older D3 versions cannot be recovered by this update.
Storage is limited to 8 MiB per thought block and 64 MiB per thread. If a limit
is reached, saved text remains readable with a notice; the live preview continues.

Delivered advisor findings appear as expandable **Advisor feedback** in the activity history, with severity and advisor name when supplied by OMP. Feedback can arrive during a task or after its answer. This shows delivered findings, not private advisor reasoning or an inferred advisor health status. It requires the D3 extension; findings previously omitted by ACP are not retroactively imported.

D3 tries to restore advisor feedback once if its connection drops, without retrying or cancelling your task. Some feedback may be missed during a disconnect. If feedback stops, wait until the task is idle and reopen the provider session.

If an OMP model request fails, D3 marks the turn as failed while keeping any partial output. Review the output and workspace before sending another message; D3 does not automatically resubmit the failed prompt. Native failure reporting requires the D3 extension to load in OMP. If its outcome cannot be read, D3 retains the status reported by ACP.

## Models and profiles

Choose a discovered model in the composer. Add separate provider instances when projects need different OMP profiles or credentials. **Launch arguments** support settings such as `--profile work` and `--config ~/.omp/work.yml`.

Add an extension-only model's full `provider/id` selector under **Custom models**. D3's model checks do not load extensions, skills, or rules.

## Permissions and limitations

D3's permission mode controls OMP approvals. **Supervised** and **Auto** ask for approval; **Auto-accept edits** permits writes; **Full access** permits unrestricted tools. OMP can request an additional confirmation for some operations.

OMP supports new and resumed conversations, streaming, tool events, usage, images, approval forms, interruption, and model changes. Provider-history rollback and D3's Plan toggle are not available for OMP.
