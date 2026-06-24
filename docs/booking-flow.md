# Booking Flow

1. GitHub Actions workflow starts.
2. Install dependencies and Playwright.
3. Wait until LOGIN_AT.
4. Login using IG_MEMBER_ID and IG_PIN.
5. Accept Code of Conduct if shown.
6. Navigate to booking grid.
7. Wait for 19:00 if configured.
8. Locate preferred tee time.
9. Open booking page.
10. Select player count.
11. Click 'Book teetime'.
12. If DRY_RUN=true, stop here.
13. If provisional booking page appears:
    - Open Enter Details links.
    - Search partners by the first three surname letters, then select the full
      matching member name.
    - Save partner details.
14. Click Finish.
15. Capture screenshots and logs.
16. Upload artifacts.

Key artifacts:
- run.log
- ready-*.png
- partners-complete-*.png
- page JSON diagnostics
