import { test } from "node:test";
import assert from "node:assert/strict";
import {
  two,
  normalizeTime,
  parseClock,
  parseWeekdays,
  parsePlayerNames,
  parseOptionalInteger,
  isoToDdMmYyyy,
  escapeRegex,
  isInBookingWindow,
} from "../scripts/lib/time.mjs";

test("two pads single digits", () => {
  assert.equal(two(7), "07");
  assert.equal(two(17), "17");
  assert.equal(two(0), "00");
});

test("normalizeTime accepts both HH:MM and HMM-ish inputs used in config", () => {
  assert.equal(normalizeTime("07:50"), "07:50");
  assert.equal(normalizeTime("7:50"), "07:50");
  assert.equal(normalizeTime(""), "");
  assert.equal(normalizeTime("not-a-time"), "");
});

test("parseClock parses valid times and rejects invalid ones", () => {
  assert.deepEqual(parseClock("08:20"), { hour: 8, minute: 20, minutes: 500 });
  assert.deepEqual(parseClock("18:59"), { hour: 18, minute: 59, minutes: 1139 });
  assert.throws(() => parseClock("bad"), /Invalid clock time/);
});

test("parseWeekdays handles the real BOOKING_WEEKDAYS values used in the workflows", () => {
  assert.deepEqual(parseWeekdays("Sun"), [0]);
  assert.deepEqual(parseWeekdays("Tue"), [2]);
  assert.deepEqual(parseWeekdays("Thu"), [4]);
  assert.deepEqual(parseWeekdays("Sun, Tue"), [0, 2]);
  assert.throws(() => parseWeekdays("Funday"), /Invalid BOOKING_WEEKDAYS/);
  assert.throws(() => parseWeekdays(""), /Invalid BOOKING_WEEKDAYS/);
});

test("parsePlayerNames splits on every real separator seen in configs", () => {
  assert.deepEqual(
    parsePlayerNames("Verrol Skerritt|Richard Roberts|Dean Holmes|Eddie Buckley"),
    ["Verrol Skerritt", "Richard Roberts", "Dean Holmes", "Eddie Buckley"]
  );
  assert.deepEqual(
    parsePlayerNames("Verrol Skerritt, Richard Roberts, Dean Holmes, Eddie Buckley"),
    ["Verrol Skerritt", "Richard Roberts", "Dean Holmes", "Eddie Buckley"]
  );
  assert.deepEqual(parsePlayerNames("Solo Player"), ["Solo Player"]);
  assert.deepEqual(parsePlayerNames(""), []);
});

test("parseOptionalInteger accepts blank as null and rejects non-positive values", () => {
  assert.equal(parseOptionalInteger(""), null);
  assert.equal(parseOptionalInteger(undefined), null);
  assert.equal(parseOptionalInteger("7"), 7);
  assert.throws(() => parseOptionalInteger("0"), /Invalid TARGET_DAYS_AHEAD/);
  assert.throws(() => parseOptionalInteger("abc"), /Invalid TARGET_DAYS_AHEAD/);
});

test("isoToDdMmYyyy converts the site's expected date format", () => {
  assert.equal(isoToDdMmYyyy("2026-10-25"), "25-10-2026");
  assert.throws(() => isoToDdMmYyyy("20261025"), /Invalid TARGET_DATE/);
});

test("escapeRegex escapes every regex metacharacter used in a clock string", () => {
  assert.equal(escapeRegex("08:20"), "08:20");
  assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c");
});

test("isInBookingWindow only allows the configured weekday and the 18:30-19:05 window", () => {
  const sunday = { weekdayIndex: 0, hour: 18, minute: 40 };
  const tuesday = { weekdayIndex: 2, hour: 18, minute: 40 };
  const tooEarly = { weekdayIndex: 0, hour: 18, minute: 29 };
  const tooLate = { weekdayIndex: 0, hour: 19, minute: 6 };

  assert.equal(isInBookingWindow(sunday, [0]), true);
  assert.equal(isInBookingWindow(tuesday, [0]), false, "wrong weekday must be rejected");
  assert.equal(isInBookingWindow(tooEarly, [0]), false);
  assert.equal(isInBookingWindow(tooLate, [0]), false);
});
