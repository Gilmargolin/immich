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


## Public fork security posture

This is a public repo. Before pushing:
  - no `.env`, credentials, tokens, private keys
  - no internal hostnames or deploy-script paths
  - no third-party API keys
Deploy-target specifics live in the local Claude memory, not the repo.
