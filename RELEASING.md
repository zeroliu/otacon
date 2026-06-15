# Releasing otacon

Maintainer runbook for publishing otacon to npm. The user-facing install lives in
[README.md](README.md); the rationale for this flow is in [DECISIONS.md](DECISIONS.md).

The model: you cut a release **locally** (bump + tag + push) with `bun run release`,
which never publishes. The pushed `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs the
gates and publishes from a clean CI checkout.

## One-time setup

- **Own the npm package.** Releases publish the unscoped public package `otacon`. The
  name was verified **available** on the public registry on 2026-06-15 — the first
  publish reserves it. Use an npm account that will own it. If the name gets squatted
  before the first publish, fall back to the scoped `@zeroliu/otacon` (and update
  `name` in `package.json` accordingly).
- **Create an npm automation token.** On npmjs.com → Access Tokens, create an
  **automation** token (these bypass 2FA, which is what lets CI publish unattended).
- **Store it as a repo secret named `NPM_TOKEN`:**

  ```sh
  gh secret set NPM_TOKEN   # paste the automation token when prompted
  ```

  The workflow exposes it to `npm publish` as `NODE_AUTH_TOKEN`.
- **`GITHUB_TOKEN` is automatic** — the workflow uses the default token (with
  `contents: write`) to create the GitHub Release; you do not configure it.
- **Keep the `repository` field in `package.json`.** `--provenance` validates the
  package's source repo against it; remove it and the provenance publish fails.

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

1. Checks out, sets up bun + Node 20, installs with `--frozen-lockfile`.
2. **Verifies the tag matches `package.json`'s version** (refuses a mismatch).
3. Re-runs the gates: `bun run typecheck`, `bun test`, `bun run build`.
4. **`npm publish --access public --provenance`** — `--provenance` pairs with the
   job's `id-token: write` to attach a signed provenance statement; the
   `NPM_TOKEN` secret authenticates the publish.
5. **`gh release create`** — creates the GitHub Release for the tag with generated
   notes.

Watch the run under the repo's **Actions** tab; a red gate stops the publish.

## Verify

```sh
npm view otacon version        # should report the version you just tagged
npm install -g otacon          # clean smoke install on a fresh machine/shell
otacon doctor
```

## dist-tags

Releases publish to the `latest` dist-tag by default. Prerelease / `next` tagging is
**not wired yet** — there is no flag for it in the release script or workflow today.
(Future work if prereleases become a need.)

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
