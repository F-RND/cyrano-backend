# Third-party notices

This source repository declares dependencies in `package.json` and pins resolved packages in `package-lock.json`. It does not vendor `node_modules`.

Direct runtime dependencies:

| Package | Resolved version at extraction | License |
| --- | ---: | --- |
| stripe | 22.6.2 | MIT |
| zod | 3.25.76 | MIT |

Direct development dependencies include Cloudflare Workers types and Wrangler (MIT or Apache-2.0), TypeScript (Apache-2.0), and Node/Vitest/tsx tooling (MIT).

The lockfile also resolves optional development-platform packages used by Wrangler, including Sharp/libvips variants with LGPL-3.0-or-later or combined license expressions. They are not application runtime dependencies and are not committed or bundled in this source repository. If a release artifact, container, vendored tree, or compiled distribution includes third-party software, regenerate the inventory from that artifact and distribute all required license texts and notices.

Dependency licenses remain the property of their respective copyright holders. Verify this inventory again before changing repository visibility or publishing a release.
