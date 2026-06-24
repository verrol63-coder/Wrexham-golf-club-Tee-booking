# Known Failures

## Login page changed

Symptoms:
- Login timeout
- Member ID field not found
- PIN field not found

Evidence to collect:
- screenshot
- page JSON
- run.log

## Code of Conduct page

Symptoms:
- Booking flow stalls after login

Expected behaviour:
- Accept code of conduct and continue.

## Tee time grid not available

Symptoms:
- No matching tee time found.

Check:
- Target date
- Booking window
- Course ID
- Tee time availability

## Provisional booking page

Symptoms:
- Booking created but partner names missing.

Check:
- Enter Details links
- Member search box
- Suggestion list selection
- Finish button

## Partner lookup failures

Symptoms:
- Could not select matching member.

Known players:
- Richard Roberts
- Dean Holmes
- Eddie Buckley

Expected behaviour:
- Search with the first three surname letters, for example `Rob`, `Hol`, or
  `Buc`.
- Select only a result that matches the full configured partner name.

## GitHub Actions timing issues

Symptoms:
- Workflow starts late.

Check:
- Workflow start time
- Login time
- Booking release time
- Site responsiveness
