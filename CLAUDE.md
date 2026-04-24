# Claude notes for this fork

This is a public Immich fork with a small set of custom patches on top
of upstream.


## Before touching the web editor (rotate / crop / view / save)

Read **EDITOR_ROTATION_CROP.md** in the repo root first. That area has
burned many debugging sessions. The doc lists the 10 specific gotchas
I have hit and a regression checklist to run before pushing.

Short version of the biggest trap: **never mix `style={blob}` with
`element.style.prop = ...` on the same element**. The blob binding
replaces the whole style attribute on each derived re-run and wipes
the imperative inline styles — which was the "image stretches when
rotating + cropping" bug. Use `style:property={value}` directives
instead.


## Before committing to main

The owner must explicitly approve commits to `main` before you push.
Do not bypass this.


## Fork-custom server additions and mobile compatibility

This fork adds server-side features that upstream mobile apps don't
know about (e.g. `AssetEditAction.Adjust` from the image-adjustment
sliders feature). If any such custom value leaks into the
`/api/sync/stream` response, the upstream iOS / Android app's
openapi-generated Dart deserializer crashes (`SyncAssetEditV1.fromJson`
throws `Null check operator used on a null value`), the
`runInIsolateGentle` isolate dies, and the user sees **"cannot process
backup"** — manual uploads still work because they don't go through
the sync stream.

Filter the custom values out of sync emissions — see
`AssetEditSync.getUpserts` in `server/src/repositories/sync.repository.ts`
for the pattern. Any new `AssetEditAction.*` the fork adds needs a
corresponding exclusion in that query.


## Public fork security posture

This is a public repo. Before pushing:
  - no `.env`, credentials, tokens, private keys
  - no internal hostnames or deploy-script paths
  - no third-party API keys
Deploy-target specifics live in the local Claude memory, not the repo.
