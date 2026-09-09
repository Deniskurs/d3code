# D3 Code assets

The active D3 icon family lives in `devis/dev`, `devis/nightly`, and `devis/prod`.
Development uses teal with a DEV badge, nightly uses violet with a NIGHTLY badge,
and production uses amber. All use the D3 mark.

Run `vp run icons:export` to regenerate the SVG, PNG, ICO, Android layers, and
Icon Composer projects from `scripts/export-devis-icons.ts`. Run `vp run icons:check`
to verify the generated assets. The renderer uses the existing scripts workspace
Sharp dependency. macOS icons have a 100px transparent inset on a 1024px canvas.

The original upstream icon sources remain in `dev`, `nightly`, and `prod` for
attribution and upstream maintenance. They are not the active D3 build assets.
