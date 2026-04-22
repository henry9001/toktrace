# Releasing toktrace

Releases are automated: pushing a `v*.*.*` git tag triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public`.

## Prerequisites (one-time)

1. Npm account with publish rights to `toktrace`.
2. GitHub secret `NPM_TOKEN` — an npm "Automation" access token (Settings → Access Tokens → Generate New Token → Classic → Automation).

## Cutting a release

From a clean `master`:

```bash
npm version patch   # 0.1.0 -> 0.1.1  (use minor / major as appropriate)
git push --follow-tags
```

`npm version` bumps `package.json`, commits, and creates the tag. `--follow-tags` pushes both the commit and the tag. The tag push fires the workflow.

## Verifying

After the workflow turns green:

```bash
npm view toktrace version          # should print the new version
mkdir /tmp/tt && cd /tmp/tt
npm init -y && npm install toktrace
npx toktrace --help                # smoke-test the CLI
```

## Manual republish

If a publish fails after the tag is pushed, re-run via `workflow_dispatch` with the tag name in the input, rather than recreating the tag.

## Hotfix flow

1. Branch from the latest tag: `git checkout -b hotfix/x.y.z vX.Y.(Z-1)`
2. Fix, test, commit.
3. Merge to `master`.
4. `npm version patch && git push --follow-tags`.

## What runs before publish

- `prepack` → `npm run build` (ensures `dist/` is fresh in the tarball)
- `prepublishOnly` → `typecheck + lint + test` (quality gate before the registry gets it)

If either fails, `npm publish` aborts.
