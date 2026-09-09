# Oh My Pi

D3 Code includes Oh My Pi (OMP) as an enabled provider. OMP connects your coding workspace to model subscriptions and API accounts.

## Set up your account

During first-run setup, D3 checks whether OMP is installed. Choose **Install** if it is missing. If it is already installed, choose **Set up accounts** to connect a subscription or API key and select your default model.

The setup terminal opens in a large dialog. Choose **Run setup**, follow OMP's prompts, then **Close and check**. You can reopen it from **Settings > Providers > Oh My Pi** at any time. Named OMP profiles use their own account setup.

An available model catalog does not guarantee that an old subscription login is still valid. If OMP reports an expired login, reopen **Set up accounts**, sign in again, close the panel, and retry your message.

Use **Check for updates** in the provider settings to keep OMP current. D3's application updates and OMP's runtime updates are separate.

## Steer or queue a message

You can send another message while OMP is working. In the web or desktop composer, choose:

- **Steer** to redirect the running task at OMP's next message or tool boundary. It does not stop the current model response instantly.
- **Queue** to save a follow-up until the current task finishes. The send button uses the same label, and Enter follows the selected mode.

The queue is attached to the composer. You can edit or remove unsent messages, pause and resume delivery from a chosen message, or choose **Send now** to steer with a queued message. Delivery pauses after a stopped or failed task and while OMP needs an approval or answer. Use **Send now** when you are ready to continue after a failure.

Queued messages and their attachments are saved on the device where you queued them. Keep D3 open to deliver them; reopening it resumes the queue after reconnecting. Switching conversations does not stop delivery. The queue is not shared with another device or the native mobile client. A file restored from an older draft may need reattaching before it can be saved in the queue.

Messages become read-only once submission starts. If delivery cannot be confirmed, **Retry delivery** reuses the original message ID to avoid a duplicate. **Submitted** means the server accepted the command; the conversation shows the response when OMP processes it.

Other clients default to steering when sending to a running OMP session. If an OMP installation cannot load D3's steering extension, messages fall back to waiting for the current turn.

## Resume a conversation

Open the same D3 thread and send your next message. D3 saves the OMP session reference with that thread. After D3 or its server restarts, it loads that OMP session again using the saved workspace and provider instance. You do not need to copy the resume command printed by OMP's terminal UI.

OMP owns the underlying session files. Keep the same OMP profile and its session data when continuing a thread. If that data is missing or the saved reference is invalid, resuming reports an error; the visible D3 history remains available. Create a new thread when you want a fresh session.

## Models and profiles

Choose a discovered model in the composer. Add separate provider instances when projects need different OMP profiles or credentials. **Launch arguments** support settings such as `--profile work` and `--config ~/.omp/work.yml`.

Add an extension-only model's full `provider/id` selector under **Custom models**. D3's model checks do not load extensions, skills, or rules.

## Permissions and limitations

D3's permission mode controls OMP approvals. **Supervised** and **Auto** ask for approval; **Auto-accept edits** permits writes; **Full access** permits unrestricted tools. OMP can request an additional confirmation for some operations.

OMP supports new and resumed conversations, streaming, tool events, usage, images, approval forms, interruption, and model changes. Provider-history rollback and D3's Plan toggle are not available for OMP.
