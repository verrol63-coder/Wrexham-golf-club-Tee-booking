# Artifact Troubleshooting

When a booking fails, inspect artifacts in this order.

## 1. run.log

Usually contains the exact failing step.

Look for:
- timeout
- selector failures
- missing tee time
- login problems
- partner lookup failures

## 2. Latest screenshot

Determine what page the browser actually reached.

Common states:
- login page
- code of conduct page
- tee grid
- booking form
- provisional booking page
- confirmation page

## 3. Page JSON

Use when selectors fail.

Compare page content with expected selectors in scripts/book-tee.mjs.

## 4. Diagnostics files

Look for:
- no-input
- partner-not-found
- provisional-booking
- existing-booking-partners-incomplete

## Recommended Codex workflow

Do not scan the entire repository.

Provide:
- failing screenshot
- relevant run.log excerpt
- relevant function from scripts/book-tee.mjs

Ask for one focused investigation and minimal diff.