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
  players: env("PLAYER_NAMES", "Verrol Skerritt|Richard Roberts|Dean Holmes|Eddie Buckly")
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean),
  courseId: env("COURSE_ID", "779"),
  groupId: env("GROUP_ID", "1"),
  dryRun: flag("DRY_RUN"),
  requireBookingWindow: flag("REQUIRE_BOOKING_WINDOW", true),
  waitFor1900: flag("WAIT_FOR_1900", true),
  targetDate: env("TARGET_DATE", ""),
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

  const targetDateIso = config.targetDate || defaultTargetDateIso();
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
    await loginAsMember(page);
    await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissCookieBanner(page);

    if (config.waitFor1900) {
      await waitUntilBookingOpens();
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
}

async function attemptTime(page, gridUrl, time) {
  const bookingUrl = `${gridUrl}&book=${encodeURIComponent(`${time}:00`)}`;
  console.log(`Trying ${time} via ${bookingUrl}`);

  await page.goto(bookingUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await dismissCookieBanner(page);
  await guardAgainstUnexpectedScreens(page, time);

  const unavailable = await hasText(page, /not available|no longer available|already booked|fully booked|booking is not open|not yet open/i);
  if (unavailable) {
    console.log(`${time} is not available yet or has already gone.`);
    return "unavailable";
  }

  await fillBookingForm(page);
  await saveScreenshot(page, `ready-${time.replace(":", "")}.png`);

  if (config.dryRun) {
    console.log(`Dry run reached the booking screen for ${time}. No final submit clicked.`);
    return "dry-run";
  }

  const clicked = await clickFinalBookingButton(page);
  if (!clicked) {
    throw new Error(`Reached ${time}, but could not find a safe final booking/confirm button.`);
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await saveScreenshot(page, `submitted-${time.replace(":", "")}.png`);

  const finalText = await bodyText(page);
  if (/confirmed|booked|booking reference|success|thank you/i.test(finalText)) {
    console.log(`Booking appears confirmed for ${time} on ${config.targetDate || defaultTargetDateIso()}.`);
    return "booked";
  }

  if (/payment|card number|checkout|pay now/i.test(finalText)) {
    throw new Error("A payment screen appeared, but this member booking should require no payment. Stopping.");
  }

  console.log("Submitted the booking form. Confirmation text was not obvious; inspect uploaded artifacts.");
  return "booked";
}

async function guardAgainstUnexpectedScreens(page, time) {
  const body = await bodyText(page);

  if (await page.locator("#memberid, #pin").first().isVisible().catch(() => false)) {
    throw new Error("The site returned to the member login page. The session may not have been retained.");
  }

  if (await page.locator("#teeemail, #teepassword").first().isVisible().catch(() => false)) {
    throw new Error("The site showed the visitor tee-time login instead of the member booking flow.");
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
  await fillPlayerNames(page, config.players);
}

async function setPlayerCount(page, count) {
  const selects = await page.locator("select").all();
  for (const select of selects) {
    const name = `${await select.getAttribute("name").catch(() => "")} ${await select.getAttribute("id").catch(() => "")}`.toLowerCase();
    if (!/player|slot|ball|number|num|count/.test(name)) continue;

    for (const value of [String(count), `${count} players`, `${count} Player`, `${count} Players`]) {
      if (await select.selectOption({ label: value }).then(() => true).catch(() => false)) return;
      if (await select.selectOption(value).then(() => true).catch(() => false)) return;
    }
  }
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

async function clickFinalBookingButton(page) {
  const labels = [/confirm/i, /book/i, /reserve/i, /submit/i, /finish/i, /save/i];
  const blockers = /back|cancel|login|register|reset|search|change/i;

  for (const label of labels) {
    const buttons = await page.locator("button, input[type='submit'], a.btn").all();
    for (const button of buttons) {
      const text = `${await button.innerText().catch(() => "")} ${await button.getAttribute("value").catch(() => "")}`.trim();
      if (!label.test(text) || blockers.test(text)) continue;
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click();
      return true;
    }
  }

  return false;
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

async function waitUntilBookingOpens() {
  const start = Date.now();
  while (Date.now() - start < 7 * 60 * 1000) {
    const now = londonNow();
    const minutes = now.hour * 60 + now.minute;
    if (minutes >= 19 * 60) {
      console.log(`Booking window is open in ${TIME_ZONE}: ${two(now.hour)}:${two(now.minute)}:${two(now.second)}.`);
      return;
    }
    await sleep(250);
  }

  throw new Error("Waited for 19:00 Europe/London, but it did not arrive inside the maximum wait window.");
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

function defaultTargetDateIso() {
  const today = londonNow();
  const daysUntilSunday = (7 - today.weekdayIndex) % 7;
  const daysToAdd = daysUntilSunday === 0 ? 7 : daysUntilSunday;
  return addDaysIso(today, daysToAdd);
}

function addDaysIso(parts, days) {
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  const future = londonParts(noonUtc);
  return `${future.year}-${two(future.month)}-${two(future.day)}`;
}

function isInBookingWindow(parts) {
  if (parts.weekdayIndex !== 0) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= 18 * 60 + 55 && minutes <= 19 * 60 + 5;
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

async function hasText(page, pattern) {
  return pattern.test(await bodyText(page));
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}

async function saveFailureArtifacts(page, error) {
  await saveScreenshot(page, "failure.png").catch(() => {});
  await fs.writeFile(path.join(ARTIFACT_DIR, "failure.txt"), `${error.stack || error.message}\n`, "utf8").catch(() => {});
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
