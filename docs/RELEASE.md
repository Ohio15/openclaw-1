---
title: Ohio15 Release Runbook
description: How the Ohio15 fork of OpenClaw cuts, builds, records and rolls back a gateway release
---

# Ohio15 Release Runbook

## 1. Purpose, owner, independence

This runbook releases the OpenClaw gateway image from the Ohio15 fork
(`Ohio15/openclaw-1`, a public fork of `openclaw/openclaw`) for the gateway
that runs on NEXUS. Owner: Ron (Ohio15). Every step below is a command a person
runs; no AI agent, AI vendor or AI session is needed to release, build, deploy
or roll back (dev-standards STANDARDS section 13).

Scope split:

- This repository: source, `.github/workflows/ohio-release.yml` (build and
  record the image), this runbook.
- `Ohio15/infra`: everything about running it (the nexus-deploy stack spec
  `nexus-deploy/stacks/openclaw.json`, the env file location, the compose
  overlay). Deploy configuration is never committed to this public repository.

## 2. Inputs and prerequisites

- GitHub account with write access to `Ohio15/openclaw-1` (tag push).
- The fenced ephemeral-VM runner fleet `nexus-ci` (`Ohio15/infra` `ci-vm/`).
  The workflow uses the repository variable `CI_RUNNER` when set, else
  `nexus-ci`; it never falls back to a GitHub-hosted runner.
- GitHub Container Registry package `ghcr.io/ohio15/openclaw-gateway`
  (created by the first release; pushed with the workflow's `GITHUB_TOKEN`).
- NEXUS host, deploy tree `/home/ohio_/OpenClaw`, git remotes:
  `origin` = `git@github.com:Ohio15/openclaw-1.git`,
  `upstream` = `https://github.com/openclaw/openclaw.git`.
- Secrets: none are read by the release workflow beyond `GITHUB_TOKEN`.
  Runtime secrets belong to the infra stack (see `Ohio15/infra`).

Current limitation (2026-11-27): the `nexus-ci` registrar serves only
repositories GitHub reports as private, and this fork is public, so a release
tag queues until either the repository visibility decision (work item
e2d8461a) or a registrar change lets `nexus-ci` serve it. Until then use the
manual fallback in section 7.

## 3. Version rules

Two version strings, each with one job:

- Release tag: `v<upstream-base>-ohio.<N>`, annotated. `<upstream-base>` is
  the upstream tag the fork is built on (`git describe --tags --abbrev=0
--exclude '*-ohio.*'`), for example `v2026.2.24` or `v2026.3.23-beta.1`.
  `<N>` starts at 1 for each base and increments by one per release; it never
  reuses a number and never reuses an upstream tag name. Example:
  `v2026.2.24-ohio.1`.
- App version: `package.json` `version` (the Ohio15 line, e.g. `2026.2.50`),
  bumped in every change PR together with a `CHANGELOG.md` entry that names
  it. The release notes record both.

## 4. Pre-flight

Run from a clone with `origin` = the fork:

```bash
git fetch origin --tags
git switch main
git status -sb                              # expect: ## main...origin/main, clean
git rev-list --count HEAD..origin/main      # expect: 0
git describe --tags --abbrev=0 --exclude '*-ohio.*'   # the upstream base
git tag -l 'v*-ohio.*' --sort=-v:refname | head -3    # last Ohio15 tags
```

The commit to release must be on `main` (merged through a PR whose CI passed).
The workflow refuses any other commit.

## 5. Cut

```bash
BASE=$(git describe --tags --abbrev=0 --exclude '*-ohio.*')
N=1   # next unused number for this BASE (see the tag list above)
TAG="${BASE}-ohio.${N}"
git tag -a "$TAG" -m "Ohio15 release $TAG: upstream $BASE + $(git rev-list --count "$BASE"..HEAD) commits, app $(jq -r .version package.json)"
git push origin "$TAG"
```

Never move or delete a pushed release tag; cut the next `N` instead.

## 6. CI path

Workflow: **Ohio15 Release** (`.github/workflows/ohio-release.yml`), started
by the tag push. Watch it at
`https://github.com/Ohio15/openclaw-1/actions/workflows/ohio-release.yml` or
`gh run list -R Ohio15/openclaw-1 -w "Ohio15 Release"`.

It validates the tag (format, annotated, upstream base is an ancestor, commit
is on `main`), builds `Dockerfile` for `linux/amd64` with default build
arguments, pushes `ghcr.io/ohio15/openclaw-gateway:<tag>` and `:<commit sha>`,
checks the registry serves the built digest under the tag, and creates the
GitHub Release for the tag. The release notes are the digest record:

```bash
gh release view "$TAG" -R Ohio15/openclaw-1          # image@digest, commit, base, run
docker buildx imagetools inspect "ghcr.io/ohio15/openclaw-gateway:$TAG"
```

Upstream's `docker-release.yml` ignores `*-ohio.*` tags.

Controls held in repository settings, not in the workflow file (a tag push
runs the tagged commit's own copy of the workflow, so in-file checks alone
cannot bound a release):

- Environment `ohio-release`: the job may run only for tags matching
  `v*-ohio.*`.
- Ruleset `ohio-release-tags-immutable`: tags matching `v*-ohio.*` cannot be
  moved or deleted once pushed.
- Deploy pins `image@digest` from the release notes, never the mutable tag
  (requirement on the `openclaw` stack in `Ohio15/infra`).

## 7. Manual fallback

Use when CI cannot run (runner unavailable). Build on a Docker host that is
NOT the NEXUS production host, from the tagged commit:

```bash
git switch --detach "$TAG"
gh auth refresh -s write:packages
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
docker buildx build --platform linux/amd64 --push \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --label org.opencontainers.image.version="$TAG" \
  -t "ghcr.io/ohio15/openclaw-gateway:$TAG" .
docker buildx imagetools inspect "ghcr.io/ohio15/openclaw-gateway:$TAG"   # note the digest
gh release create "$TAG" -R Ohio15/openclaw-1 --verify-tag --title "$TAG" \
  --notes "manual-release: image ghcr.io/ohio15/openclaw-gateway:$TAG@<digest>, commit $(git rev-parse HEAD)"
```

Record the release as `manual-release` in the release notes.

Deploy (both paths) is done from `Ohio15/infra` through the nexus-deploy stack
`openclaw`: `sudo nexus-deploy openclaw plan "$TAG"` (dry run, exit 0), then
`sudo nexus-deploy openclaw deploy "$TAG"`. UNVERIFIED: the `openclaw` stack
spec is not installed yet (infra slice S6); until it is, the running gateway
stays on its existing image and is not redeployed from this runbook.

## 8. Verify at the boundary

- Release notes digest == `docker buildx imagetools inspect` digest.
- After a deploy (UNVERIFIED until the stack exists):
  `sudo nexus-deploy openclaw status` exits 0 (7 = running digest differs
  from the release), `docker inspect --format '{{index .RepoDigests 0}}'
openclaw-openclaw-gateway-1` matches the release digest, the gateway health
  endpoint answers, and Signal inbound messages are processed.

## 9. Rollback

`sudo nexus-deploy openclaw rollback` (UNVERIFIED until the stack exists and a
rollback has been rehearsed). Until then the hand-made `openclaw:rollback-*`
image tags on NEXUS remain the rollback path and are kept.

## 10. Backup and restore

The gateway's state is outside this repository; see `Ohio15/infra`
`backup/RESTORE.md`. The NEXUS deploy tree's full git history was bundled on
2026-11-27 (`~/quarantine/2026-11-27-openclaw/openclaw-all-20261127.bundle`)
and its HEAD pushed as branch `nexus-snapshot-20261127`.

## 11. Third parties and replacement path

- GitHub (source, Actions control plane, Releases): replaceable by the
  self-hosted Forgejo in `Ohio15/infra` `forgejo/`.
- GitHub Container Registry: replaceable by a self-hosted OCI registry; only
  the `IMAGE` value in the workflow and the stack spec change.
- Upstream `openclaw/openclaw`: sync by `git fetch upstream --tags` and a
  merge PR into `main`; the fork builds and runs without upstream reachable.

## 12. Proven on

| Date       | Step                                                    | Boundary                                          |
| ---------- | ------------------------------------------------------- | ------------------------------------------------- |
| 2026-11-27 | Git bundle + snapshot branch, remote layout (section 2) | `git ls-remote origin` snapshot sha == NEXUS HEAD |
| -          | CI build (section 6)                                    | UNVERIFIED: no run yet                            |
| -          | Deploy, verify, rollback                                | UNVERIFIED: stack spec pending (S6)               |
