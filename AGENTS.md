# AGENTS.md

## Purpose

This file defines how agents should work in this repository. The goal is to keep changes accurate, safe, and reviewable for the OCI Service Limits Dashboard.

## Repository Context

- This is a Node.js and Express application.
- The server entrypoint is `src/server.js`.
- OCI scan logic lives in `src/limitsScan.js` and OCI SDK wrappers live in `src/limitsClient.js`.
- Browser UI code is in `public/`.
- Safe runtime configuration is documented in `.env.example`.
- User-facing setup and operating instructions live in `README.md`.
- The default Git branch is `master`.

## Required Validation

For JavaScript or server/UI behavior changes, run:

```bash
npm run check
npm test
```

For documentation-only changes, at minimum inspect the README diff:

```bash
git diff -- README.md
```

When changing README structure, also verify top-level sections:

```bash
rg '^## ' README.md
```

## OCI and Secret Safety

- Never commit `.env`, `.env.*` except `.env.example`, OCI private keys, `~/.oci` contents, API keys, auth tokens, downloaded tenancy exports, or raw customer scan output.
- Screenshot assets are allowed only when they do not expose sensitive OCIDs, private tenancy names, user identities, IP addresses, or operationally sensitive limits.
- Keep `.gitignore` and `.dockerignore` aligned with this rule.
- Do not bake OCI credentials into Docker images.

## README Safety Rules

- Do not silently delete meaningful README content.
- If a README edit removes sections or non-trivial setup/operation guidance, call that out explicitly.
- Keep these topics accurate when relevant:
  - screenshot
  - requirements
  - OCI policy
  - local run
  - configuration
  - dashboard workflow
  - API
  - Docker run
  - development
  - operational notes
- If code behavior changes, update README instructions in the same change when users would otherwise be misled.

## Change Discipline

- Keep changes small and focused.
- Prefer the existing code style and local helper functions over new abstractions.
- Do not revert user changes unless explicitly requested.
- Avoid unrelated refactors.
- Commit only files that belong to this app.
- Do not commit `node_modules`, coverage output, local logs, generated exports, or local browser state.

## UI Expectations

- The app is an operational dashboard, not a marketing site.
- Keep the interface dense, readable, and practical.
- Preserve searchable multi-select filters, sortable/resizable tables, alert policy controls, scan progress, theme support, CSV/Excel download behavior, and the compact footer unless the task explicitly changes them.
- After significant frontend changes, run the app locally and visually verify the page in a browser when practical.

## Scan Behavior Notes

- OCI does not expose exact per-request scan progress.
- Progress reporting should remain honest: region/service progress, active region/service, elapsed time, row counts, and errors are acceptable; fake precision is not.
- Be conservative with scan concurrency defaults. Raising concurrency can trigger OCI throttling.
