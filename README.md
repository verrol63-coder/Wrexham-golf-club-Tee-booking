# Wrexham Golf Club tee booking automation

This repository contains a scheduled cloud automation for booking the weekly Wrexham Golf Club Sunday tee time.

## Booking rule

- Runs on Sunday evening and targets the following Sunday, 7 days ahead.
- Logs in before booking opens and waits for 19:00 Europe/London.
- Tries `07:50` first.
- Tries `08:30` second if the first time is unavailable.
- Books 4 players: Verrol Skerritt, Richard Roberts, Dean Holmes, Eddie Buckly.
- Stops rather than bypassing CAPTCHA, MFA, security checks, payment screens, or unexpected pages.

## Required GitHub secrets

Add these in **Settings -> Secrets and variables -> Actions -> Repository secrets**:

- `IG_MEMBER_ID`: your Wrexham / IntelligentGolf member login.
- `IG_PIN`: your Wrexham / IntelligentGolf PIN.

Do not commit these values to the repo.

## Manual test

Use **Actions -> Book Wrexham Sunday tee -> Run workflow**.

For a safe test, choose `dry_run=true`. The workflow will log in and try to reach the booking screen, but it will not click the final booking button. Screenshots are uploaded as workflow artifacts.

## Notes

GitHub Actions schedules are not guaranteed to start at the exact second. The workflow is scheduled at the London-time equivalent of 18:58 in both BST and GMT, then the script waits until 19:00 before attempting to submit. This is cloud-independent from a MacBook, but no hosted scheduler can guarantee being first if GitHub starts the job late or the golf site is slow.
