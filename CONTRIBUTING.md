# Contributing to D3 Code

D3 Code (Devis) is maintained by [Denis](https://github.com/Deniskurs).

Report bugs and propose improvements in [this repository's issues](https://github.com/Deniskurs/d3code/issues).
Include the D3 version, operating system, provider version, and steps to reproduce.
Do not include credentials or private conversation data.

For larger changes, discuss the intended behavior before implementing it. Keep
pull requests focused and explain the problem, resulting behavior, and validation.
Include screenshots for visible interface changes.

## Development

Install Vite+, run `vp i`, then `vp run dev`. Use the pairing URL printed by the
server. Read [AGENTS.md](AGENTS.md) for workspace safety and testing conventions.

Run focused tests and affected package typechecks. Preserve provider behavior
across local and remote environments, and consider desktop, web, and mobile clients
when changing shared contracts.

Keep copyright and license notices intact. Never commit credentials, generated
installers, private test data, or temporary working notes.
