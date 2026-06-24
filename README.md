# Wrexham Golf Club tee booking automation

This repository contains scheduled cloud automations for Wrexham Golf Club tee-time booking.

## Booking rules

- Sunday evening: targets the following Sunday, 7 days ahead.
  - Tries `07:50` first.
  - Tries `08:30` second if the first time is unavailable.
  - Books 4 players: Verrol Skerritt, Richard Roberts, Dean Holmes, Eddie Buckley.
- Tuesday evening: targets the following Tuesday, 7 days ahead.
  - Tries `07:30`.
  - Books Verrol Skerritt only.
- Thursday evening: targets the following Thursday, 7 days ahead.
  - Tries `07:30`.
  - Books Verrol Skerritt only.
- Each workflow starts early, waits to log in at 18:59 Europe/London, then waits for 19:00 before booking.
- The workflows stop rather than bypassing CAPTCHA, MFA, security checks, payment screens, or unexpected pages.

## Required GitHub secrets

Add these in **Settings -> Secrets and variables -> Actions -> Repository secrets**:

- `IG_MEMBER_ID`: your Wrexham / IntelligentGolf member login.
- `IG_PIN`: your Wrexham / IntelligentGolf PIN.

Do not commit these values to the repo.

## Manual test

Use the GitHub **Actions** tab and choose the relevant workflow.

For a safe test, choose `dry_run=true`. The workflow will log in and try to reach the booking screen, but it will not click the final booking button. Screenshots are uploaded as workflow artifacts.

## Custom booking UI

Use **Actions -> Book Wrexham custom tee -> Run workflow** to run the automation
with your own date, tee times, and player list.

Recommended custom run settings:

- `target_date`: exact tee date, such as `2026-07-05`.
- `primary_time`: first tee time to try, such as `07:50`.
- `secondary_time`: optional fallback tee time, such as `08:30`.
- `player_names`: comma, semicolon, newline, or `|` separated names. The first
  player is the logged-in member.
- `dry_run`: keep `true` for testing; set `false` only when you intend to submit
  a booking.
- `require_booking_window`: keep `true` for real booking-window runs.
- `booking_days`: the weekday when the workflow is allowed to run with booking
  protection enabled, such as `Sun`, `Tue`, or `Thu`.

For an existing provisional booking, enter its `booking_edit_id` and the workflow
will complete the configured partner details and click `Finish` when all names
are present.

## Notes

GitHub Actions schedules are not guaranteed to start at the exact second. Each workflow is scheduled at the London-time equivalent of 18:35 in both BST and GMT, then the script waits until 18:59 to log in and 19:00 before attempting to submit immediately when booking opens. This is cloud-independent from a MacBook, but no hosted scheduler can guarantee being first if GitHub starts the job late or the golf site is slow.
