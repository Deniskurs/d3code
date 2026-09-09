# Oh My Pi

D3 Code includes Oh My Pi (OMP) as an enabled provider. OMP connects your coding workspace to model subscriptions and API accounts.

## Set up your account

During first-run setup, D3 checks whether OMP is installed. Choose **Install** if it is missing. If it is already installed, choose **Set up accounts** to connect a subscription or API key and select your default model.

The setup terminal opens in a large dialog. Choose **Run setup**, follow OMP's prompts, then **Close and check**. You can reopen it from **Settings > Providers > Oh My Pi** at any time. Named OMP profiles use their own account setup.

An available model catalog does not guarantee that an old subscription login is still valid. If OMP reports an expired login, reopen **Set up accounts**, sign in again, close the panel, and retry your message.

Use **Check for updates** in the provider settings to keep OMP current. D3's application updates and OMP's runtime updates are separate.

## Steer or queue a message

You can send another message while OMP is working. In the web or desktop composer, choose:

- **Steer current task** to redirect the running task. OMP may interrupt its current tool batch to follow your new instruction.
- **Queue after current task** to start a separate turn when the current task finishes.

Then send with the arrow button or Enter. Steering also supports attached images. Other clients default to steering when sending to a running OMP session. If an OMP installation cannot load D3's steering extension, messages fall back to waiting for the current turn.

## Models and profiles

Choose a discovered model in the composer. Add separate provider instances when projects need different OMP profiles or credentials. **Launch arguments** support settings such as `--profile work` and `--config ~/.omp/work.yml`.

Add an extension-only model's full `provider/id` selector under **Custom models**. D3's model checks do not load extensions, skills, or rules.

## Permissions and limitations

D3's permission mode controls OMP approvals. **Supervised** and **Auto** ask for approval; **Auto-accept edits** permits writes; **Full access** permits unrestricted tools. OMP can request an additional confirmation for some operations.

OMP supports new and resumed conversations, streaming, tool events, usage, images, approval forms, interruption, and model changes. Provider-history rollback and D3's Plan toggle are not available for OMP.
