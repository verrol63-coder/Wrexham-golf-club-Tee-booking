import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const TIME_ZONE = "Europe/London";
const ARTIFACT_DIR = "artifacts";

const config = {
  bookingUrl: env("BOOKING_URL", "https://www.wrexhamgolfclub.co.uk/memberbooking/"),
  loginUrl: env("LOGIN_URL", "https://www.wrexhamgolfclub.co.uk/login.php"),
  memberId: env("IG_MEMBER_ID", env("IG_USERNAME", env("IG_LOGIN", ""))),
  pin: env("IG_PIN", env("IG_PASSWORD", "")),
  primaryTime: normalizeTime(env("PRIMARY_TEE_TIME", "07:50")),
  secondaryTime: normalizeTime(env("SECONDARY_TEE_TIME", "08:30")),
  players: parsePlayerNames(env("PLAYER_NAMES", "Verrol Skerritt|Richard Roberts|Dean Holmes|Eddie Buckley")),
  courseId: env("COURSE_ID", "779"),
  groupId: env("GROUP_ID", "1"),
  dryRun: flag("DRY_RUN"),
  requireBookingWindow: flag("REQUIRE_BOOKING_WINDOW", true),
  bookingWeekdays: parseWeekdays(env("BOOKING_WEEKDAYS", "Sun")),
  targetDaysAhead: parseOptionalInteger(env("TARGET_DAYS_AHEAD", "")),
  waitForLogin: flag("WAIT_FOR_LOGIN", true),
  loginAt: env("LOGIN_AT", "18:59"),
  waitFor1900: flag("WAIT_FOR_1900", true),
  targetDate: env("TARGET_DATE", ""),
  bookingEditId: env("BOOKING_EDIT_ID", ""),
};

const candidateTimes = [config.primaryTime, config.secondaryTime].filter(Boolean);

await main();

async function main() {
  validateConfig();
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const now = londonNow();
  if (config.requireBookingWindow && !isInBookingWindow(now)) {
    console.log(
      `Outside booking window in ${TIME_ZONE}: ${now.weekday} ${two(now.hour)}:${two(now.minute)}. Exiting without booking.`
    );
    return;
  }

  const targetDateIso = config.targetDate || defaultTargetDateIso(now);
  const targetDateParam = isoToDdMmYyyy(targetDateIso);
  const gridUrl = buildBookingUrl(targetDateParam);

  console.log(`Target date: ${targetDateIso}`);
  console.log(`Preferred times: ${candidateTimes.join(", ")}`);
  console.log(`Players: ${config.players.join(", ")}`);
  console.log(config.dryRun ? "DRY_RUN=true: final submit will not be clicked." : "DRY_RUN=false: booking will be submitted if the expected form is reached.");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: TIME_ZONE,
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();

  try {
    if (config.waitForLogin) {
      await waitUntilLocalClock(config.loginAt, "login");
    }

    await loginAsMember(page);

    if (config.bookingEditId) {
      const editUrl = buildEditBookingUrl(config.bookingEditId);
      console.log(`Completing partner details for existing booking ${config.bookingEditId}.`);
      await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await dismissCookieBanner(page);
      if (await acceptCodeOfConductIfPresent(page)) {
        await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await dismissCookieBanner(page);
      }

      await completePartnerDetails(page, config.primaryTime || "booking", config.players);
      const readyText = await confirmationCheckText(page);
      const finishClicked = await finishPartnerDetailsIfPresent(page, readyText, config.players);
      await saveScreenshot(page, `partners-complete-${(config.primaryTime || "booking").replace(":", "")}.png`);

      const completedText = await confirmationCheckText(page);
      if (finishClicked || isPartnerDetailsComplete(completedText, config.players)) {
        console.log(`Partner details appear complete for existing booking ${config.bookingEditId}.`);
        return;
      }

      await savePageDiagnostics(page, "existing-booking-partners-incomplete").catch(() => {});
      throw new Error(`Entered partner details for existing booking ${config.bookingEditId}, but the page still did not look complete.`);
    }

    await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissCookieBanner(page);

    // The site gates the booking area behind a one-time "Tee Time Booking Code of
    // Conduct" consent page (ttbconsent.php) for a fresh session. If we land there,
    // accept it and go back to the grid we actually wanted.
    if (await acceptCodeOfConductIfPresent(page)) {
      await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await dismissCookieBanner(page);
    }

    // DIAGNOSTIC: capture what the tee sheet grid actually looks like before release.
    await captureGridDiagnostics(page, "grid-before-release");

    if (config.waitFor1900) {
      await waitUntilLocalClock("19:00", "booking window");

      // Re-load the grid fresh right after release, since slots may only render as
      // live, clickable links once the booking window actually opens.
      await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await dismissCookieBanner(page);
      if (await acceptCodeOfConductIfPresent(page)) {
        await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await dismissCookieBanner(page);
      }
      await captureGridDiagnostics(page, "grid-after-release");
    }

    for (const time of candidateTimes) {
      const result = await attemptTime(page, gridUrl, time);
      if (result === "booked" || result === "dry-run") {
        return;
      }
    }

    throw new Error(`Neither preferred tee time was bookable: ${candidateTimes.join(", ")}`);
  } catch (error) {
    await saveFailureArtifacts(page, error);
    throw error;
  } finally {
    await browser.close();
  }
}

async function loginAsMember(page) {
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await dismissCookieBanner(page);

  const memberField = page.locator("#memberid");
  const pinField = page.locator("#pin");

  if (!(await memberField.isVisible({ timeout: 10000 }).catch(() => false))) {
    console.log("Member login form was not visible; continuing in case an existing session is active.");
    return;
  }

  await memberField.fill(config.memberId);
  await pinField.fill(config.pin);

  const keepLoggedIn = page.locator('input[name="cachemid"]');
  if (await keepLoggedIn.isVisible().catch(() => false)) {
    await keepLoggedIn.check().catch(() => {});
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator('input[type="submit"][value="Login"], button:has-text("Login")').first().click(),
  ]);

  const body = await bodyText(page);
  if (/invalid|incorrect|try again|login required/i.test(body) && (await memberField.isVisible().catch(() => false))) {
    throw new Error("Member login did not succeed. Check IG_MEMBER_ID and IG_PIN secrets.");
  }
  if (await isRegistrationPage(page, body)) {
    throw new Error("Member login did not reach the booking area; the site showed a registration page. Check IG_MEMBER_ID and IG_PIN secrets.");
  }
}

async function attemptTime(page, gridUrl, time) {
  console.log(`Trying ${time} on the live grid.`);

  // Always start from the plain grid for this attempt, in case a previous
  // attempt left the page in a different state.
  await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await dismissCookieBanner(page);

  if (await acceptCodeOfConductIfPresent(page)) {
    await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await dismissCookieBanner(page);
  }

  await guardAgainstUnexpectedScreens(page, time);

  // The site renders one "Book" link per open slot, each with its own href like
  // "?date=...&book=17:40:00" (confirmed from real site diagnostics). Scoping to
  // this exact href means we can never click a different time's button, even
  // though many other "Book" links for other times are on the same page.
  const bookLink = page.locator(`a.inlineBooking[href*="book=${time}:00"]`).first();
  const isBookable = await bookLink.isVisible({ timeout: 2000 }).catch(() => false);

  if (!isBookable) {
    const stillTaken = await hasText(
      page,
      /not available|no longer available|already booked|fully booked|booking is not open|not yet open/i
    );
    console.log(
      stillTaken
        ? `${time} is not available - the slot text indicates it's taken or not open yet.`
        : `${time} has no visible "Book" link on the grid - most likely already taken.`
    );
    return "unavailable";
  }

  console.log(`Clicking Book for ${time}.`);
  await bookLink.click();

  // The site expands that row inline (rather than navigating to a new page), so
  // wait for the matching submit button to render before doing anything else.
  const submitButton = await findBookingSubmitButton(page, time, 20000);
  if (!submitButton) {
    await savePageDiagnostics(page, `no-inline-form-${time.replace(":", "")}`).catch(() => {});
    await saveScreenshot(page, `no-inline-form-${time.replace(":", "")}.png`).catch(() => {});
    throw new Error(`Clicked Book for ${time}, but its inline booking form/submit button never appeared. See diagnostics.`);
  }

  await fillBookingForm(page);

  const afterFillText = await confirmationCheckText(page);
  if (isConfirmationText(afterFillText)) {
    console.log(`Booking appears confirmed for ${time} on ${config.targetDate || defaultTargetDateIso()}.`);
    await saveScreenshot(page, `submitted-${time.replace(":", "")}.png`);
    return "booked";
  }
  if (/payment|card number|checkout|pay now/i.test(afterFillText)) {
    throw new Error("A payment screen appeared, but this member booking should require no payment. Stopping.");
  }

  await saveScreenshot(page, `ready-${time.replace(":", "")}.png`);

  if (config.dryRun) {
    console.log(`Dry run reached the booking screen for ${time}. No final submit clicked.`);
    return "dry-run";
  }

  console.log(`Clicking the scoped submit button: Book teetime at ${time}.`);
  await submitButton.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await saveScreenshot(page, `submitted-${time.replace(":", "")}.png`);

  const finalText = await confirmationCheckText(page);
  if (isProvisionalBookingText(finalText)) {
    console.log(`Provisional booking held for ${time}; entering playing partner details.`);
    await completePartnerDetails(page, time, config.players);
    const readyText = await confirmationCheckText(page);
    const finishClicked = await finishPartnerDetailsIfPresent(page, readyText, config.players);
    await saveScreenshot(page, `partners-complete-${time.replace(":", "")}.png`);

    const completedText = await confirmationCheckText(page);
    if (finishClicked || isPartnerDetailsComplete(completedText, config.players)) {
      console.log(`Booking details appear complete for ${time} on ${config.targetDate || defaultTargetDateIso()}.`);
      return "booked";
    }

    await savePageDiagnostics(page, `partners-incomplete-${time.replace(":", "")}`).catch(() => {});
    throw new Error(`Entered partner details for ${time}, but the page still did not look complete. See diagnostics.`);
  }

  if (isConfirmationText(finalText)) {
    console.log(`Booking appears confirmed for ${time} on ${config.targetDate || defaultTargetDateIso()}.`);
    return "booked";
  }

  if (/payment|card number|checkout|pay now/i.test(finalText)) {
    throw new Error("A payment screen appeared, but this member booking should require no payment. Stopping.");
  }

  await savePageDiagnostics(page, `unclear-result-${time.replace(":", "")}`).catch(() => {});
  throw new Error(`Clicked the booking submit button for ${time}, but no clear confirmation text was found afterward. Treating as failed rather than assuming success - see diagnostics.`);
}

async function findBookingSubmitButton(page, time, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const label = new RegExp(`book\\s+tee\\s*time\\s+at\\s+${escapeRegex(time)}`, "i");

  while (Date.now() < deadline) {
    const candidates = await page.locator("button, input[type='submit'], input[type='button'], a.btn, a.button").all();
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (label.test(await controlText(candidate))) return candidate;
    }
    await sleep(250);
  }

  return null;
}

// Some generic site notices (e.g. an unrelated sidebar reminder) contain words
// like "booked" and would otherwise cause a false-positive confirmation match.
// Strip known noise phrases before testing for a real confirmation.
function confirmationCheckText(page) {
  return bodyText(page).then((text) =>
    text.replace(/you\s+already\s+have\s+a\s+teetime\s+booked\s+for\s+this\s+day[^\n]*/gi, "")
  );
}

function isConfirmationText(text) {
  return /confirmed|booking reference|thank you for your booking|your booking is confirmed/i.test(text);
}

function isProvisionalBookingText(text) {
  return /provisionally\s+reserved|enter\s+the\s+details\s+of\s+your\s+playing\s+partners|you\s+must\s+enter\s+the\s+names\s+of\s+your\s+playing\s+partners/i.test(
    text
  );
}

async function guardAgainstUnexpectedScreens(page, time) {
  const body = await bodyText(page);

  if (await page.locator("#memberid, #pin").first().isVisible().catch(() => false)) {
    throw new Error("The site returned to the member login page. The session may not have been retained.");
  }

  if (await page.locator("#teeemail, #teepassword").first().isVisible().catch(() => false)) {
    throw new Error("The site showed the visitor tee-time login instead of the member booking flow.");
  }

  if (await isRegistrationPage(page, body)) {
    throw new Error(`The site showed a registration page instead of the member booking form for ${time}. The login/session may not be valid.`);
  }

  if (/captcha|security check|verify you are human/i.test(body)) {
    throw new Error("A CAPTCHA or security check appeared. Stopping rather than bypassing it.");
  }

  if (/payment|card number|checkout|pay now/i.test(body)) {
    throw new Error("A payment flow appeared. Stopping because the member booking should not require payment.");
  }

  if (!new RegExp(time.replace(":", "\\s*:?\\s*")).test(body) && !/book|confirm|reserve|player|member/i.test(body)) {
    console.log("Could not clearly verify booking page text, but continuing to look for a booking form.");
  }
}

async function fillBookingForm(page) {
  await setPlayerCount(page, config.players.length);
  // The initial "Book" popup has no name-entry fields; partner names are added
  // from the provisional booking page after the slot is reserved.
  await fillPlayerNames(page, config.players);
}

async function setPlayerCount(page, count) {
  // Confirmed from real diagnostics: the site uses radio inputs named "numslots"
  // with values 1-4, NOT a link or <select>. Multiple copies of this radio group
  // exist in the DOM (one per bookable slot on the grid), so we must scope to the
  // one that's actually visible - i.e. the popup tied to the slot we just clicked.
  const radio = page.locator(`input[name="numslots"][value="${count}"]:visible`).first();
  const isPresent = await radio.isVisible({ timeout: 3000 }).catch(() => false);
  if (!isPresent) {
    console.log(`Could not find a visible numslots radio for ${count} players.`);
    return;
  }
  console.log(`Selecting ${count} players via numslots radio.`);
  await radio.check().catch(() => {});
}

async function fillPlayerNames(page, players) {
  const visibleInputs = await page
    .locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea')
    .all();

  const candidateInputs = [];
  for (const input of visibleInputs) {
    if (!(await input.isVisible().catch(() => false))) continue;
    const descriptor = [
      await input.getAttribute("name").catch(() => ""),
      await input.getAttribute("id").catch(() => ""),
      await input.getAttribute("placeholder").catch(() => ""),
      await input.getAttribute("aria-label").catch(() => ""),
    ]
      .join(" ")
      .toLowerCase();

    if (/csrf|password|pin|email|phone|mobile|terms|note|comment/.test(descriptor)) continue;
    if (/player|member|guest|name|partner|slot/.test(descriptor)) {
      candidateInputs.push(input);
    }
  }

  const namesToFill = players.slice(1);
  for (let i = 0; i < Math.min(namesToFill.length, candidateInputs.length); i += 1) {
    await candidateInputs[i].fill(namesToFill[i]).catch(async () => {
      await candidateInputs[i].click();
      await candidateInputs[i].pressSequentially(namesToFill[i], { delay: 15 });
    });
    await page.keyboard.press("Tab").catch(() => {});
  }

  if (namesToFill.length > candidateInputs.length) {
    console.log(
      `Only found ${candidateInputs.length} partner/player fields for ${namesToFill.length} additional players. The booking page may use a custom member picker.`
    );
  }
}

async function completePartnerDetails(page, time, players) {
  const partnerNames = players.slice(1);
  if (partnerNames.length === 0) return;

  await savePageDiagnostics(page, `provisional-${time.replace(":", "")}`).catch(() => {});

  for (let index = 0; index < partnerNames.length; index += 1) {
    const playerNumber = index + 2;
    const partnerName = partnerNames[index];
    let currentText = await bodyText(page);

    if (playerNameLooksPresent(currentText, partnerName)) {
      console.log(`Player ${playerNumber} already appears to be ${partnerName}.`);
      continue;
    }

    if (!isProvisionalBookingText(currentText)) {
      await savePageDiagnostics(page, `before-player-${playerNumber}-unexpected-page`).catch(() => {});
      throw new Error(`Expected the provisional booking page before entering Player ${playerNumber}, but found a different page.`);
    }

    const detailsLink = await findEnterDetailsLink(page, playerNumber);
    if (!detailsLink) {
      await savePageDiagnostics(page, `missing-player-${playerNumber}-details-link`).catch(() => {});
      throw new Error(`Could not find the Enter Details link for Player ${playerNumber}.`);
    }

    console.log(`Opening Enter Details for Player ${playerNumber}: ${partnerName}.`);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      detailsLink.click(),
    ]);
    await dismissCookieBanner(page);
    await savePageDiagnostics(page, `player-${playerNumber}-details-opened`).catch(() => {});

    await fillPartnerDetailPage(page, partnerName, playerNumber);
    await returnToProvisionalBookingIfNeeded(page);

    currentText = await bodyText(page);
    if (!playerNameLooksPresent(currentText, partnerName)) {
      await savePageDiagnostics(page, `player-${playerNumber}-not-saved`).catch(() => {});
      throw new Error(`Entered Player ${playerNumber} as ${partnerName}, but the booking page did not show that name afterward.`);
    }

    await saveScreenshot(page, `player-${playerNumber}-${safeLabel(partnerName)}.png`).catch(() => {});
  }
}

async function findEnterDetailsLink(page, playerNumber) {
  const rowLink = page
    .locator(`xpath=//*[normalize-space(.)="Player ${playerNumber}"]/following::a[contains(normalize-space(.), "Enter Details")][1]`)
    .first();
  if (await rowLink.isVisible({ timeout: 1000 }).catch(() => false)) return rowLink;

  const links = await page.getByRole("link", { name: /enter details/i }).all();
  for (const link of links) {
    if (await link.isVisible().catch(() => false)) return link;
  }

  return null;
}

async function fillPartnerDetailPage(page, partnerName, playerNumber) {
  await openAnotherMemberPicker(page);

  const input = await findPartnerInput(page);
  if (!input) {
    await savePageDiagnostics(page, `player-${playerNumber}-no-input`).catch(() => {});
    throw new Error(`Could not find a visible name/member search input for Player ${playerNumber}.`);
  }

  const searchTerm = partnerSearchTerm(partnerName);
  console.log(`Searching partner surname prefix for Player ${playerNumber}: ${searchTerm}.`);
  await input.fill(searchTerm).catch(async () => {
    await input.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await input.pressSequentially(searchTerm, { delay: 20 });
  });

  if (!(await selectPartnerSuggestion(page, partnerName))) {
    await savePageDiagnostics(page, `player-${playerNumber}-partner-not-found`).catch(() => {});
    throw new Error(`Could not select a matching member record for Player ${playerNumber}: ${partnerName}.`);
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(500);
}

async function findPartnerInput(page) {
  const candidates = await page
    .locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea')
    .all();

  let fallback = null;
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const descriptor = [
      await candidate.getAttribute("name").catch(() => ""),
      await candidate.getAttribute("id").catch(() => ""),
      await candidate.getAttribute("placeholder").catch(() => ""),
      await candidate.getAttribute("aria-label").catch(() => ""),
      await candidate.getAttribute("title").catch(() => ""),
    ]
      .join(" ")
      .toLowerCase();

    if (/csrf|password|pin|email|phone|mobile|terms|note|comment|date|time/.test(descriptor)) continue;
    if (/member|player|guest|name|partner|search/.test(descriptor)) return candidate;
    fallback ??= candidate;
  }

  return fallback;
}

async function openAnotherMemberPicker(page) {
  const anotherMember = page.getByRole("link", { name: /another member/i }).first();
  if (!(await anotherMember.isVisible({ timeout: 1000 }).catch(() => false))) return;

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    anotherMember.click(),
  ]);
  await dismissCookieBanner(page);
  await sleep(500);
}

async function selectPartnerSuggestion(page, partnerName) {
  await sleep(750);

  const exactSuggestion = await findPartnerResult(page, partnerName, "exact");
  if (exactSuggestion) {
    await exactSuggestion.click();
    return true;
  }

  const searchButton = await findActionButton(page, [/search/i, /find/i, /lookup/i, /^submit$/i], /cancel|back|delete|remove/i);
  if (searchButton) {
    console.log(`Submitting member surname search for ${partnerName}.`);
    await searchButton.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(750);

    const searchedMatch = await findPartnerResult(page, partnerName, "matching-name");
    if (searchedMatch) {
      console.log(`Selecting visible member result for ${partnerName}.`);
      await searchedMatch.click();
      return true;
    }

    await selectFirstInitialRange(page, partnerName);

    const rangedMatch = await findPartnerResult(page, partnerName, "matching-name");
    if (rangedMatch) {
      console.log(`Selecting ranged member result for ${partnerName}.`);
      await rangedMatch.click();
      return true;
    }
  }

  return false;
}

async function selectFirstInitialRange(page, partnerName) {
  const label = firstInitialRangeLabel(partnerName);
  if (!label) return;

  const rangeLink = page.getByRole("link", { name: label }).first();
  if (!(await rangeLink.isVisible({ timeout: 1000 }).catch(() => false))) return;

  console.log(`Filtering member results to first-name range ${label}.`);
  await rangeLink.click().catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(1500);
}

function firstInitialRangeLabel(partnerName) {
  const first = String(partnerName || "").trim()[0]?.toUpperCase();
  if (!first) return "";
  if (first >= "A" && first <= "E") return "A - E";
  if (first >= "F" && first <= "J") return "F - J";
  if (first >= "K" && first <= "O") return "K - O";
  if (first >= "P" && first <= "T") return "P - T";
  if (first >= "U" && first <= "Z") return "U - Z";
  return "";
}

async function findPartnerResult(page, partnerName, mode) {
  const links = await page.locator('a[href*="addpartner="]').all();
  const target = normalizeHumanText(partnerName);
  const targetParts = target.split(" ").filter(Boolean);

  for (const link of links) {
    if (!(await link.isVisible().catch(() => false))) continue;
    const text = normalizeHumanText(await controlText(link));
    if (mode === "exact" && text === target) return link;
    if (mode === "matching-name" && (text === target || text.startsWith(`${target} `))) return link;
    if (mode === "matching-name" && targetParts.length > 1 && targetParts.every((part) => text.includes(part))) return link;
    if (mode === "all-parts" && targetParts.length > 1 && targetParts.every((part) => text.includes(part))) return link;
  }

  return null;
}

async function clickPartnerDetailSubmit(page, playerNumber) {
  const submitButton = await findActionButton(
    page,
    [/save/i, /update/i, /add/i, /confirm/i, /continue/i, /submit/i, /done/i],
    /cancel|remove|delete|back|logout|login|home|news|information|competition|diary|cookie/i
  );

  if (!submitButton) {
    await savePageDiagnostics(page, `player-${playerNumber}-no-submit`).catch(() => {});
    throw new Error(`Could not find a safe submit/save button for Player ${playerNumber}.`);
  }

  console.log(`Saving details for Player ${playerNumber}.`);
  await submitButton.click();
}

async function returnToProvisionalBookingIfNeeded(page) {
  const text = await bodyText(page);
  if (isProvisionalBookingText(text)) return;

  const backLink = await findActionButton(page, [/back to booking/i, /return to booking/i, /done/i, /continue/i], /cancel|remove|delete|logout|login/i);
  if (!backLink) return;

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    backLink.click(),
  ]);
  await dismissCookieBanner(page);
}

async function finishPartnerDetailsIfPresent(page, text, players) {
  if (!allPartnerNamesPresent(text, players)) return false;

  const finishLink = page.locator("a.finish, a[href*='redirectToHome=1']").filter({ hasText: /finish/i }).first();
  if (!(await finishLink.isVisible({ timeout: 1000 }).catch(() => false))) {
    console.log("All partner names are present, but no Finish link was visible.");
    return false;
  }

  console.log("Clicking Finish to send partner emails.");
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    finishLink.click(),
  ]);
  await dismissCookieBanner(page);
  await sleep(500);
  return true;
}

async function findActionButton(page, labels, blockers) {
  const candidates = await page.locator("button, input[type='submit'], input[type='button'], a.btn, a.button, a").all();
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await controlText(candidate);
    const href = `${await candidate.getAttribute("href").catch(() => "")}`;
    if (!text && !href) continue;
    if (blockers.test(text) || blockers.test(href)) continue;
    if (labels.some((label) => label.test(text) || label.test(href))) return candidate;
  }
  return null;
}

async function controlText(locator) {
  return [
    await locator.innerText().catch(() => ""),
    await locator.getAttribute("value").catch(() => ""),
    await locator.getAttribute("aria-label").catch(() => ""),
    await locator.getAttribute("title").catch(() => ""),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function isPartnerDetailsComplete(text, players) {
  const namesPresent = allPartnerNamesPresent(text, players);
  if (namesPresent && /successfully\s+entered\s+the\s+details\s+of\s+all\s+your\s+playing\s+partners/i.test(text)) return true;
  return namesPresent && !/enter details|you must enter the names of your playing partners/i.test(text);
}

function allPartnerNamesPresent(text, players) {
  return players.slice(1).every((name) => playerNameLooksPresent(text, name));
}

function playerNameLooksPresent(text, name) {
  const normalizedText = normalizeHumanText(text);
  const normalizedName = normalizeHumanText(name);
  if (normalizedText.includes(normalizedName)) return true;

  const parts = normalizedName.split(" ").filter(Boolean);
  return parts.length > 1 && parts.every((part) => normalizedText.includes(part));
}

function normalizeHumanText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeLabel(value) {
  return normalizeHumanText(value).replace(/\s+/g, "-") || "player";
}

function partnerSearchTerm(name) {
  const surname = String(name || "").trim().split(/\s+/).at(-1) || "";
  const prefix = surname.replace(/[^a-z0-9]/gi, "").slice(0, 3);
  return prefix || surname || name;
}

async function acceptCodeOfConductIfPresent(page) {
  // The site gates booking behind a one-time consent page (ttbconsent.php) for a
  // fresh session, with an exact link: text "I accept this code of conduct",
  // href "?action=accept", class "btn btn-success". Confirmed from real diagnostics.
  const acceptLink = page.getByRole("link", { name: "I accept this code of conduct" });
  const isPresent = await acceptLink.isVisible({ timeout: 1000 }).catch(() => false);
  if (!isPresent) return false;

  console.log("Tee Time Booking Code of Conduct gate detected; accepting it.");
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    acceptLink.click(),
  ]);
  return true;
}

async function dismissCookieBanner(page) {
  for (const name of [/accept/i, /agree/i, /close/i, /ok/i]) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click().catch(() => {});
      return;
    }
  }
}

async function waitUntilLocalClock(hhmm, label) {
  const target = parseClock(hhmm);
  const start = Date.now();
  while (Date.now() - start < 40 * 60 * 1000) {
    const now = londonNow();
    const minutes = now.hour * 60 + now.minute;
    if (minutes >= target.minutes) {
      console.log(`${label} time reached in ${TIME_ZONE}: ${two(now.hour)}:${two(now.minute)}:${two(now.second)}.`);
      return;
    }
    await sleep(250);
  }

  throw new Error(`Waited for ${hhmm} Europe/London, but it did not arrive inside the maximum wait window.`);
}

function validateConfig() {
  if (!config.memberId) throw new Error("Missing IG_MEMBER_ID secret.");
  if (!config.pin) throw new Error("Missing IG_PIN secret.");
  if (candidateTimes.length === 0) throw new Error("At least one tee time must be configured.");
  if (config.players.length === 0) throw new Error("At least one player must be configured.");
}

function buildBookingUrl(dateParam) {
  const url = new URL(config.bookingUrl);
  url.searchParams.set("date", dateParam);
  url.searchParams.set("course", config.courseId);
  url.searchParams.set("group", config.groupId);
  return url.toString();
}

function buildEditBookingUrl(editId) {
  const url = new URL(config.bookingUrl);
  url.searchParams.set("edit", editId);
  url.searchParams.set("newbooking", "1");
  return url.toString();
}

function defaultTargetDateIso(parts = londonNow()) {
  if (config.targetDaysAhead !== null) {
    return addDaysIso(parts, config.targetDaysAhead);
  }

  const daysUntilSunday = (7 - parts.weekdayIndex) % 7;
  const daysToAdd = daysUntilSunday === 0 ? 7 : daysUntilSunday;
  return addDaysIso(parts, daysToAdd);
}

function addDaysIso(parts, days) {
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  const future = londonParts(noonUtc);
  return `${future.year}-${two(future.month)}-${two(future.day)}`;
}

function isInBookingWindow(parts) {
  if (!config.bookingWeekdays.includes(parts.weekdayIndex)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= 18 * 60 + 30 && minutes <= 19 * 60 + 5;
}

function londonNow() {
  return londonParts(new Date());
}

function londonParts(date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    weekday: parts.weekday,
    weekdayIndex,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function isoToDdMmYyyy(isoDate) {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) throw new Error(`Invalid TARGET_DATE: ${isoDate}`);
  return `${day}-${month}-${year}`;
}

function normalizeTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):?(\d{2})$/);
  if (!match) return "";
  return `${two(Number(match[1]))}:${match[2]}`;
}

function parseClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    minutes: Number(match[1]) * 60 + Number(match[2]),
  };
}

function parseWeekdays(value) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const indexes = String(value || "")
    .split(/[|, ]+/)
    .map((day) => day.trim())
    .filter(Boolean)
    .map((day) => names.findIndex((name) => name.toLowerCase() === day.slice(0, 3).toLowerCase()));

  if (indexes.length === 0 || indexes.some((index) => index === -1)) {
    throw new Error(`Invalid BOOKING_WEEKDAYS: ${value}`);
  }

  return indexes;
}

function parsePlayerNames(value) {
  return String(value || "")
    .split(/[|,;\r\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid TARGET_DAYS_AHEAD: ${value}`);
  }
  return number;
}

async function hasText(page, pattern) {
  return pattern.test(await bodyText(page));
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}

async function isRegistrationPage(page, body = "") {
  const hasRegisterText = /\bregister\b/i.test(body) && /already have an account|log in|repeat password/i.test(body);
  const hasRegisterFields = await page
    .locator('input[name*="forename" i], input[name*="surname" i], input[name*="repeat" i], input[name*="password" i]')
    .count()
    .then((count) => count >= 2)
    .catch(() => false);
  return hasRegisterText || hasRegisterFields;
}

async function saveFailureArtifacts(page, error) {
  await saveScreenshot(page, "failure.png").catch(() => {});
  await savePageDiagnostics(page, "failure").catch(() => {});
  await fs.writeFile(path.join(ARTIFACT_DIR, "failure.txt"), `${error.stack || error.message}
`, "utf8").catch(() => {});
}

async function captureGridDiagnostics(page, label) {
  await saveScreenshot(page, `${label}.png`).catch(() => {});
  await savePageDiagnostics(page, label).catch(() => {});
}

async function savePageDiagnostics(page, label) {
  const diagnostics = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 5000) || "",
    controls: Array.from(document.querySelectorAll("button, input, a"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return style && style.display !== "none" && style.visibility !== "hidden";
      })
      .slice(0, 160)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "",
        text: element.innerText || element.getAttribute("value") || element.getAttribute("aria-label") || element.getAttribute("title") || "",
        href: element.getAttribute("href") || "",
        name: element.getAttribute("name") || "",
        id: element.getAttribute("id") || "",
        value: element.getAttribute("value") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        className: element.getAttribute("class") || "",
        onclick: element.getAttribute("onclick") || "",
        dataset: { ...element.dataset },
      })),
  }));
  await fs.writeFile(path.join(ARTIFACT_DIR, `${label}-page.json`), JSON.stringify(diagnostics, null, 2), "utf8");
}

async function saveScreenshot(page, filename) {
  await page.screenshot({ path: path.join(ARTIFACT_DIR, filename), fullPage: true });
}

function flag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

function env(name, defaultValue = "") {
  return process.env[name] ?? defaultValue;
}

function two(value) {
  return String(value).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
