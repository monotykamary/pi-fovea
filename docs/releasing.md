# Releasing the extension and standalone CLI

The root `package.json` remains **`pi-fovea`**, including its existing Pi entry
points and legacy `fovea` bin. **`@monotykamary/fovea`** is a separate CLI-only
distribution generated from the same source, version, and `dist/cli.mjs` bundle.
There is no second version to maintain and no extension build step.

## Prepare and check

Use the project's normal versioning process to set the root package version.
Both packages use that version. With development dependencies and Bend 2.0.26
installed, run:

```sh
bun run check:fast
bun run pack:cli                         # writes dist/fovea-cli.tgz
bun run check:package:cli dist/fovea-cli.tgz
bun pm pack --filename dist/pi-fovea.tgz --quiet
bun run check:package dist/pi-fovea.tgz
```

`pack:cli` runs the same proof and fresh-bundle gate as the root `prepack` hook,
then stages an allowlisted package outside the checkout. It does not rename or
rewrite the root manifest. The CLI manifest has no Pi registration, Pi peers,
TypeScript loader, or install/build hooks. It retains the optional ast-grep
parser dependency, licenses, and auditable proof receipt inputs/outputs.
`docs/cli.md` becomes its npm README.

`check:package:cli` without an archive builds and checks a temporary tarball.
With an archive, it checks that exact artifact without rebuilding it. Checks
cover metadata, proof hashes, license files, compiler-free execution, and an
offline npm global install in a disposable prefix (optional parsers omitted).
CI checks both distributions. Neither check publishes anything.

## Publish the checked artifacts

After checking the version and authenticating to npm as an account allowed to
publish in the `@monotykamary` scope, publish the **same checked tarballs**:

```sh
bun publish dist/fovea-cli.tgz --access public
bun publish dist/pi-fovea.tgz --access public
```

These are two independent registry publications, not an atomic release. A
staged-version 409, 2FA/OTP notice, or empty `/-/stage` response is pending:
wait for completion rather than bumping, retagging, or retrying.

After the first public CLI release, users can run:

```sh
npm install -g @monotykamary/fovea
fovea sketch /path/to/repo 900
```

The command stays `fovea`. Users migrating from a global `pi-fovea` install
should uninstall that global package first; both own the same executable.
`pi install npm:pi-fovea` is unchanged and can coexist with the standalone CLI.
