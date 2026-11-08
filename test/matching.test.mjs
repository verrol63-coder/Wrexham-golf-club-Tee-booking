import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHumanText,
  partnerSearchTerm,
  firstInitialRangeLabel,
  isConfirmationText,
  isProvisionalBookingText,
  playerNameLooksPresent,
  allPartnerNamesPresent,
  isPartnerDetailsComplete,
  classifyPartnerCandidate,
} from "../scripts/lib/matching.mjs";

// The exact 31 candidates returned by the live site on 2026-11-08 when
// searching surname prefix "Rob" for "Richard Roberts" - captured verbatim
// from that run's own diagnostics logging. The correct match
// ("Richard Roberts (17.8)") is in here, and the matcher failed to select it
// due to an unrelated bug (isVisible() not waiting) - this suite locks down
// that the matching logic itself picks the right one out of this exact list.
const REAL_ROB_SEARCH_RESULTS = [
  "\n    A P Roberts (10.2) \n    ",
  "\n    Alan J Roberts (17.2) \n    ",
  "\n    Anne Roberts (19.9) \n    ",
  "\n    Arnold Anthony Roberts (16.5) \n    ",
  "\n    Barbara Roberts (N/A)\n    ",
  "\n    Barry Roberts (17.9) \n    ",
  "\n    Chris J Roberts (9.9) \n    ",
  "\n    Denise Roberts (37.7) \n    ",
  "\n    Graham Roberts (17.7) \n    ",
  "\n    June Denise Roberts (31.6) \n    ",
  "\n    Lee Roberts (10.0) \n    ",
  "\n    Mark Roberts (N/A)\n    ",
  "\n    Martin Roberts (N/A)\n    ",
  "\n    Martin Lloyd Roberts (19.1) \n    ",
  "\n    Matthew Roberts (8.3) \n    ",
  "\n    Richard Roberts (17.8) \n    ",
  "\n    Selwyn Roberts (25.3) \n    ",
  "\n    Stan Roberts (23.3) \n    ",
  "\n    Sue Roberts (24.0) \n    ",
  "\n    Tim Roberts (26.5) \n    ",
  "\n    Vaughan Roberts (N/A)\n    ",
  "\n    Wayne Roberts (19.5) \n    ",
  "\n    Wendy Roberts (19.6) \n    ",
  "\n    Willow Roberts (N/A)\n    ",
  "\n    Harvey Roberts (J) (6.8) \n    ",
  "\n    Louisa Nathalie Roberts (J) (22.3) \n    ",
  "\n    Reuben Roberts (J) (26.1) \n    ",
  "\n    Bailey Roberts-Bain (25.7) \n    ",
  "\n    Daniel Robertson (17.1) \n    ",
  "\n    Alfie Robinson (54.0) \n    ",
];

test("classifyPartnerCandidate selects the correct Richard Roberts out of 30 similar real candidates", () => {
  const matches = REAL_ROB_SEARCH_RESULTS.filter(
    (text) => classifyPartnerCandidate(text, "Richard Roberts", "matching-name").isMatch
  );
  assert.deepEqual(matches, ["\n    Richard Roberts (17.8) \n    "]);
});

test("classifyPartnerCandidate does not mistake a different Roberts for Richard Roberts", () => {
  const result = classifyPartnerCandidate("\n    A P Roberts (10.2) \n    ", "Richard Roberts", "matching-name");
  assert.equal(result.isMatch, false);
  assert.equal(result.isInitialCandidate, false, "no first-name part of A P Roberts starts with Richard's initial R");
});

test("classifyPartnerCandidate exact mode requires an exact normalized match", () => {
  assert.equal(classifyPartnerCandidate("Richard Roberts", "Richard Roberts", "exact").isMatch, true);
  assert.equal(classifyPartnerCandidate("Richard Roberts (17.8)", "Richard Roberts", "exact").isMatch, false);
});

test("classifyPartnerCandidate flags an unambiguous surname+initial match as an initial candidate", () => {
  // Only one "R* Smith" among these, so it should be usable as a last resort.
  const result = classifyPartnerCandidate("Rob Smith (12.0)", "Robert Smith", "matching-name");
  assert.equal(result.isMatch, false);
  assert.equal(result.isInitialCandidate, true);
});

test("classifyPartnerCandidate leaves ambiguous surname+initial matches to the caller", () => {
  // Two different first names both starting with "D" sharing a surname -
  // classifyPartnerCandidate flags both as candidates; it's the caller's job
  // (findPartnerResult) to only auto-select when there's exactly one.
  const a = classifyPartnerCandidate("Dave Holmes (10.0)", "Dean Holmes", "matching-name");
  const b = classifyPartnerCandidate("Derek Holmes (11.0)", "Dean Holmes", "matching-name");
  assert.equal(a.isMatch, false);
  assert.equal(a.isInitialCandidate, true);
  assert.equal(b.isMatch, false);
  assert.equal(b.isInitialCandidate, true);
});

test("classifyPartnerCandidate all-parts mode matches regardless of word order", () => {
  assert.equal(classifyPartnerCandidate("Roberts, Richard", "Richard Roberts", "all-parts").isMatch, true);
});

test("normalizeHumanText collapses whitespace and strips punctuation while keeping digits", () => {
  assert.equal(normalizeHumanText("\n    Richard Roberts (17.8) \n    "), "richard roberts 17 8");
  assert.equal(normalizeHumanText("  Multiple   Spaces  "), "multiple spaces");
  assert.equal(normalizeHumanText(""), "");
  assert.equal(normalizeHumanText(null), "");
});

test("partnerSearchTerm takes the first three letters of the surname, preserving case as seen in real logs", () => {
  assert.equal(partnerSearchTerm("Richard Roberts"), "Rob");
  assert.equal(partnerSearchTerm("Dean Holmes"), "Hol");
  assert.equal(partnerSearchTerm("Eddie Buckley"), "Buc");
  assert.equal(partnerSearchTerm("Jo Li"), "Li");
});

test("firstInitialRangeLabel matches the real ranges the site uses, including boundaries", () => {
  assert.equal(firstInitialRangeLabel("Richard Roberts"), "P - T");
  assert.equal(firstInitialRangeLabel("Eddie Buckley"), "A - E");
  assert.equal(firstInitialRangeLabel("Dean Holmes"), "A - E");
  assert.equal(firstInitialRangeLabel("Fred Jones"), "F - J");
  assert.equal(firstInitialRangeLabel("Jack Jones"), "F - J");
  assert.equal(firstInitialRangeLabel("Kate Oslo"), "K - O");
  assert.equal(firstInitialRangeLabel("Omar Smith"), "K - O");
  assert.equal(firstInitialRangeLabel("Tina Smith"), "P - T");
  assert.equal(firstInitialRangeLabel("Uma Smith"), "U - Z");
  assert.equal(firstInitialRangeLabel("Zoe Smith"), "U - Z");
  assert.equal(firstInitialRangeLabel(""), "");
});

test("isConfirmationText / isProvisionalBookingText classify real site wording", () => {
  assert.equal(isConfirmationText("Thank you for your booking"), true);
  assert.equal(isConfirmationText("Your booking is confirmed"), true);
  assert.equal(isConfirmationText("Enter the details of your playing partners"), false);
  assert.equal(isProvisionalBookingText("You have provisionally reserved a teetime for 4 people"), true);
  assert.equal(
    isProvisionalBookingText("You must enter the names of your playing partners"),
    true
  );
  assert.equal(isProvisionalBookingText("Thank you for your booking"), false);
});

test("playerNameLooksPresent matches regardless of word order or extra text", () => {
  assert.equal(playerNameLooksPresent("Player 2 Richard Roberts", "Richard Roberts"), true);
  assert.equal(playerNameLooksPresent("Player 2 Roberts, Richard", "Richard Roberts"), true);
  assert.equal(playerNameLooksPresent("Player 2 Enter Details", "Richard Roberts"), false);
});

test("allPartnerNamesPresent / isPartnerDetailsComplete require every partner, not the member", () => {
  const players = ["Verrol Skerritt", "Richard Roberts", "Dean Holmes", "Eddie Buckley"];
  const complete = "Player 1 Verrol Skerritt Player 2 Richard Roberts Player 3 Dean Holmes Player 4 Eddie Buckley";
  const missingOne = "Player 1 Verrol Skerritt Player 2 Richard Roberts Player 3 Enter Details Player 4 Eddie Buckley";

  assert.equal(allPartnerNamesPresent(complete, players), true);
  assert.equal(allPartnerNamesPresent(missingOne, players), false);
  assert.equal(isPartnerDetailsComplete(complete, players), true);
  assert.equal(isPartnerDetailsComplete(missingOne, players), false);
  assert.equal(
    isPartnerDetailsComplete(`${complete} you must enter the names of your playing partners`, players),
    false
  );
});
