// Pure date/time/config-string parsing, split out of book-tee.mjs for the
// same reason as lib/matching.mjs: that file runs main() at import time and
// cannot be imported safely in a test.

export function two(value) {
  return String(value).padStart(2, "0");
}

export function normalizeTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):?(\d{2})$/);
  if (!match) return "";
  return `${two(Number(match[1]))}:${match[2]}`;
}

export function parseClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    minutes: Number(match[1]) * 60 + Number(match[2]),
  };
}

export function parseWeekdays(value) {
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

export function parsePlayerNames(value) {
  return String(value || "")
    .split(/[|,;\r\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function parseOptionalInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid TARGET_DAYS_AHEAD: ${value}`);
  }
  return number;
}

export function isoToDdMmYyyy(isoDate) {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) throw new Error(`Invalid TARGET_DATE: ${isoDate}`);
  return `${day}-${month}-${year}`;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isInBookingWindow(parts, bookingWeekdays) {
  if (!bookingWeekdays.includes(parts.weekdayIndex)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= 18 * 60 + 30 && minutes <= 19 * 60 + 5;
}
