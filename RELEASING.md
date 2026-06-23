# Releasing otacon

Maintainer runbook for publishing otacon to npm. The user-facing install lives in
[README.md](README.md); the rationale for this flow is in [DECISIONS.md](DECISIONS.md).

The model: you cut a release **locally** (bump + tag + push) with `bun run release`,
which never publishes. The pushed `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs the
gates and publishes from a clean CI checkout.

## One-time setup

CI publishes via **npm trusted publishing** (OIDC) — there is **no stored npm token**.
GitHub Actions mints a short-lived OpenID Connect token at publish time, and npm
exchanges it for a one-shot publish credential. Setup is a one-time bootstrap because
a Trusted Publisher can only be attached to a package that **already exists**.

1. **Own the npm package + bootstrap the first publish.** Releases publish the
   unscoped public package `otacon`. The name was verified **available** on the public
   registry on 2026-06-15 — the first publish reserves it. Trusted publishing can't do
   the *first* publish (the package doesn't exist yet to attach a publisher to), so do
   it once from your own machine:

   ```sh
   npm login                       # interactive; no long-lived token stored
   git checkout main && git pull   # clean checkout at the version you want to ship
   npm publish --access public     # prepublishOnly builds dist/; reserves the name
   ```

   If the name gets squatted first, fall back to the scoped `@zeroliu/otacon` (update
   `name` in `package.json`, and publish that scope's first version the same way).
2. **Attach the Trusted Publisher.** On npmjs.com go to the package's access page —
   `https://www.npmjs.com/package/otacon/access` → **Trusted Publisher** → add a
   GitHub Actions publisher with:
   - **Organization or user:** `zeroliu`
   - **Repository:** `otacon`
   - **Workflow filename:** `release.yml` (filename only, not a path)
   - **Environment:** leave blank (the workflow uses no GitHub Environment)
3. **`GITHUB_TOKEN` is automatic** — the workflow uses the default token (with
   `contents: write`) to create the GitHub Release; you do not configure it.
4. **Keep the `repository` field in `package.json`.** Provenance (attached
   automatically under trusted publishing) validates the package's source repo against
   it; remove it and the provenance publish fails.

After this, every tagged release publishes from CI with **no secret to rotate** — and
you can delete any old `NPM_TOKEN` repo secret if one was ever set.

## Cutting a release

From a **clean `main` checkout**:

```sh
bun run release            # patch bump (default)
bun run release minor      # or: minor / major
bun run release patch --dry-run   # rehearse: runs gates, prints commands, mutates nothing
```

`bun run release [patch|minor|major]` ([`scripts/release.sh`](scripts/release.sh)):

1. **Preflight gates** — aborts unless the working tree is clean and you are on the
   default branch (`main`), then runs `bun test`, `bun run typecheck`, and
   `bun run build`. Any failure stops before anything mutates.
2. **`npm version <kind>`** — bumps `package.json`, fires the `version` lifecycle hook
   that regenerates and stages `src/shared/version.ts` (via
   [`scripts/gen-version.ts`](scripts/gen-version.ts)), commits the bump, and creates
   the annotated `vX.Y.Z` tag.
3. **`git push --follow-tags`** — pushes the commit and the new tag to `origin`.

`--dry-run` (allowed anywhere in the args) runs the same gates but downgrades the
clean-tree / branch guards to warnings, then prints the two mutating commands
(`npm version <kind>` and `git push --follow-tags`) without running them — nothing is
bumped, committed, tagged, or pushed.

## What CI does

The pushed `v[0-9]*` tag triggers the **Release** workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. Checks out, sets up bun + Node 22, upgrades npm to latest (trusted publishing needs
   npm ≥ 11.5.1 / Node ≥ 22.14), installs with `--frozen-lockfile`.
2. **Verifies the tag matches `package.json`'s version** (refuses a mismatch).
3. Re-runs the gates: `bun run typecheck`, `bun test`, `bun run build`.
4. **`npm publish --access public`** — authenticated by the job's `id-token: write`
   OIDC token via the Trusted Publisher configured above (no token env). Provenance is
   attached automatically.
5. **`gh release create`** — creates the GitHub Release for the tag with generated
   notes.

Watch the run under the repo's **Actions** tab; a red gate stops the publish.

## Verify

```sh
npm view otacon version        # should report the version you just tagged
npm install -g otacon          # clean smoke install on a fresh machine/shell
otacon doctor
```

## Staging channel

Stable releases publish to the `latest` dist-tag (above). For preview builds testers can
opt into without affecting `latest`, otacon has a `staging` dist-tag.

Cut a staging build from a **clean `staging` branch checkout**:

```sh
bun run release:staging            # next prerelease build (default)
bun run release:staging minor      # or: minor / major (bump the base version line)
bun run release:staging --dry-run  # rehearse: runs gates, prints commands, mutates nothing
```

`bun run release:staging [minor|major]` ([`scripts/release-staging.sh`](scripts/release-staging.sh))
mirrors `bun run release`, but it guards that you are on the **`staging`** branch (not
`main`) and bumps a **prerelease** version with `npm version <mode> --preid staging`:

- no kind → `prerelease` (advances to the next patch line from a clean version, or
  increments the `-staging.N` build counter when already on a staging prerelease)
- `minor` → `preminor`, `major` → `premajor` (move the base version line first)

It commits, creates the annotated `vX.Y.Z-staging.N` tag, and `git push --follow-tags`.
The same `release.yml` workflow runs on the pushed tag, routes by version suffix to the
**`staging`** dist-tag (`npm publish --tag staging`), and creates **no GitHub Release**
(those are reserved for clean `latest` tags). Re-running `release:staging` increments the
`-staging.N` build counter and moves the `staging` dist-tag to the newest build.

Testers install from the staging channel:

```sh
npm i -g otacon@staging          # newest staging build (the staging dist-tag)
npm i -g otacon@0.1.4-staging.1  # pin an exact staging build
npm i -g otacon@latest           # leave staging, back to the stable channel
```

## Rollback / mistakes

- **Prefer a follow-up patch.** Publishing a fixed `x.y.z+1` is the clean recovery
  for almost any mistake.
- **`npm unpublish`** is allowed only within 72 hours of publish and is strongly
  discouraged (it breaks anyone who already installed). Avoid it.
- **`npm deprecate otacon@<version> "message"`** marks a bad version with an install-
  time warning without removing it — the preferred way to steer users off a release.
- **Re-pushing the same tag will not republish** — npm rejects a duplicate version, so
  a second run of an already-published `vX.Y.Z` fails at the publish step. To ship a
  fix, bump again.
