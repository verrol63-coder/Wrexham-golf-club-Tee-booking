# Codex agent instructions

Use this file as the first source of truth when running Codex or other coding agents on this repository.

## Goal

Keep agent work small, auditable, and cheap. Prefer one focused investigation or patch per run instead of broad repo-wide exploration.

## Project summary

This repository automates Wrexham Golf Club tee-time booking using GitHub Actions, Node.js, and Playwright.

Core behaviour:

- Scheduled workflows start before the 19:00 booking release window.
- The script logs in at the configured `LOGIN_AT` time.
- It waits until 19:00 when `WAIT_FOR_1900=true`.
- It books configured target tee times and player counts.
- It uploads screenshots, page JSON, and logs as artifacts.
- It must stop rather than bypassing CAPTCHA, MFA, security checks, payment screens, or unexpected pages.

## Cost-control rules for Codex

1. Do not inspect the whole repo unless explicitly asked.
2. Start with the specific file, line range, log excerpt, screenshot, or artifact named in the prompt.
3. Do one investigation pass before editing if the failure is unclear.
4. Prefer minimal diffs over rewrites.
5. Preserve existing environment variable names unless the user asks to change them.
6. Preserve dry-run behaviour.
7. Preserve booking-window protections.
8. Preserve screenshots and diagnostics around failures.
9. Do not hardcode one-off tee times into permanent scheduled workflows.
10. After changes, run only the smallest relevant checks first.

## Standard checks

Use these checks before committing JavaScript or workflow edits:

```bash
node --check scripts/book-tee.mjs
git diff --check
```

When workflow YAML changes are made, visually inspect the edited workflow for:

- valid action major versions,
- valid indentation,
- expected cron time in UTC,
- expected London-time comments,
- correct `DRY_RUN` default,
- correct artifact upload path.

## Preferred Codex prompt shape

Use this structure when asking Codex for help:

```text
Repository: Wrexham-golf-club-Tee-booking

Task: <one precise task>

Relevant files:
- <file path and line range>

Evidence:
- <paste short log excerpt or describe screenshot/artifact>

Rules:
- Do not inspect unrelated files unless needed.
- Preserve dry-run behaviour.
- Preserve booking-window protections.
- Make the smallest safe diff.
- Run node --check scripts/book-tee.mjs and git diff --check.
```

## When to ask for more evidence

If a booking issue cannot be reproduced from the code alone, request the latest GitHub Actions artifact ZIP or these files from it:

- `run.log`
- the last screenshot before failure,
- page JSON near the failure point,
- any `*-diagnostics.*` files.

## Sensitive data

Never ask the user to paste GitHub tokens, IntelligentGolf member IDs, PINs, cookies, or session values into chat. Use GitHub Actions secrets for credentials.
