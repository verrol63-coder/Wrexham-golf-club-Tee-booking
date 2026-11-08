// Pure text-matching/classification logic, deliberately split out of
// book-tee.mjs (which runs main() at import time and cannot be imported
// safely in a test). Nothing in this file touches a browser or the network,
// so it can be unit tested directly.

export function normalizeHumanText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function partnerSearchTerm(name) {
  const surname = String(name || "").trim().split(/\s+/).at(-1) || "";
  const prefix = surname.replace(/[^a-z0-9]/gi, "").slice(0, 3);
  return prefix || surname || name;
}

export function firstInitialRangeLabel(partnerName) {
  const first = String(partnerName || "").trim()[0]?.toUpperCase();
  if (!first) return "";
  if (first >= "A" && first <= "E") return "A - E";
  if (first >= "F" && first <= "J") return "F - J";
  if (first >= "K" && first <= "O") return "K - O";
  if (first >= "P" && first <= "T") return "P - T";
  if (first >= "U" && first <= "Z") return "U - Z";
  return "";
}

export function isConfirmationText(text) {
  return /confirmed|booking reference|thank you for your booking|your booking is confirmed/i.test(text);
}

export function isProvisionalBookingText(text) {
  return /provisionally\s+reserved|enter\s+the\s+details\s+of\s+your\s+playing\s+partners|you\s+must\s+enter\s+the\s+names\s+of\s+your\s+playing\s+partners/i.test(
    text
  );
}

export function playerNameLooksPresent(text, name) {
  const normalizedText = normalizeHumanText(text);
  const normalizedName = normalizeHumanText(name);
  if (normalizedText.includes(normalizedName)) return true;

  const parts = normalizedName.split(" ").filter(Boolean);
  return parts.length > 1 && parts.every((part) => normalizedText.includes(part));
}

export function allPartnerNamesPresent(text, players) {
  return players.slice(1).every((name) => playerNameLooksPresent(text, name));
}

export function isPartnerDetailsComplete(text, players) {
  const namesPresent = allPartnerNamesPresent(text, players);
  if (namesPresent && /successfully\s+entered\s+the\s+details\s+of\s+all\s+your\s+playing\s+partners/i.test(text)) return true;
  return namesPresent && !/enter details|you must enter the names of your playing partners/i.test(text);
}

// Mirrors the matching rules the live site's partner picker needs: a direct
// normalized-text match, a name that starts with the target followed by
// trailing text (ratings, membership numbers, etc.), all name parts present
// regardless of order, or - as a last resort when several members share a
// surname - a surname + first-initial match flagged as a candidate rather
// than an immediate match, so the caller only trusts it when it's unique.
// Takes the RAW (pre-normalization) candidate text, exactly as the site's
// controlText() would return it, so callers never have to normalize first.
export function classifyPartnerCandidate(rawCandidateText, partnerName, mode) {
  const text = normalizeHumanText(rawCandidateText);
  const target = normalizeHumanText(partnerName);
  const targetParts = target.split(" ").filter(Boolean);
  const firstName = targetParts[0] || "";
  const surname = targetParts.at(-1) || "";
  const initial = firstName[0] || "";

  if (mode === "exact" && text === target) {
    return { isMatch: true, isInitialCandidate: false };
  }
  if (mode === "matching-name" && (text === target || text.startsWith(`${target} `))) {
    return { isMatch: true, isInitialCandidate: false };
  }
  if (mode === "matching-name" && targetParts.length > 1 && targetParts.every((part) => text.includes(part))) {
    return { isMatch: true, isInitialCandidate: false };
  }

  let isInitialCandidate = false;
  if (mode === "matching-name" && surname && initial) {
    const textParts = text.split(" ").filter(Boolean);
    const surnameIndex = textParts.indexOf(surname);
    const hasInitial = textParts.some((part, index) => index !== surnameIndex && part[0] === initial);
    isInitialCandidate = surnameIndex !== -1 && hasInitial;
  }

  if (mode === "all-parts" && targetParts.length > 1 && targetParts.every((part) => text.includes(part))) {
    return { isMatch: true, isInitialCandidate: false };
  }

  return { isMatch: false, isInitialCandidate };
}
