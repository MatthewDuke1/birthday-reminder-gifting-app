// Date-math tests for the reminder. This is where the subtle bugs live:
// year rollover, leap days, DST boundaries, and age calculation.
let fail = 0;
const ok = (label, cond) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) fail++; };

function daysUntil(birthday, todayStr) {
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const [, bm, bd] = birthday.split("-").map(Number);
  const today = Date.UTC(ty, tm - 1, td, 12);
  let next = Date.UTC(ty, bm - 1, bd, 12);
  if (next < today) next = Date.UTC(ty + 1, bm - 1, bd, 12);
  return Math.round((next - today) / 86400000);
}

function ordinalAge(birthday, todayStr) {
  const by = Number(birthday.slice(0, 4));
  const ty = Number(todayStr.slice(0, 4));
  const [, bm, bd] = birthday.split("-").map(Number);
  const [, tm, td] = todayStr.split("-").map(Number);
  const passed = tm > bm || (tm === bm && td > bd);
  const age = ty - by + (passed ? 1 : 0);
  return age > 0 && age < 130 ? age : null;
}

// --- basic offsets -------------------------------------------------------
ok("same day is 0", daysUntil("1990-08-17", "2026-08-17") === 0);
ok("tomorrow is 1", daysUntil("1990-08-18", "2026-08-17") === 1);
ok("seven days out", daysUntil("1990-08-24", "2026-08-17") === 7);
ok("six days is not seven", daysUntil("1990-08-23", "2026-08-17") === 6);

// --- year rollover -------------------------------------------------------
ok("Jan 1 from Dec 25 is 7", daysUntil("1990-01-01", "2026-12-25") === 7);
ok("Jan 1 from Dec 31 is 1", daysUntil("1990-01-01", "2026-12-31") === 1);
ok("yesterday rolls to next year", daysUntil("1990-08-16", "2026-08-17") === 364);

// --- DST boundaries (US spring forward 2026-03-08, fall back 2026-11-01) --
ok("spans spring forward", daysUntil("1990-03-12", "2026-03-05") === 7);
ok("spans fall back", daysUntil("1990-11-05", "2026-10-29") === 7);
ok("day before spring forward", daysUntil("1990-03-08", "2026-03-07") === 1);

// --- leap year -----------------------------------------------------------
ok("Feb 29 in a leap year", daysUntil("1992-02-29", "2028-02-22") === 7);
ok("Mar 1 across Feb in leap year", daysUntil("1990-03-01", "2028-02-23") === 7);
ok("Mar 1 across Feb in non-leap", daysUntil("1990-03-01", "2026-02-22") === 7);

// --- age -----------------------------------------------------------------
ok("age on the day", ordinalAge("1990-08-17", "2026-08-17") === 36);
ok("age 7 days before", ordinalAge("1990-08-24", "2026-08-17") === 36);
ok("age after birthday passed", ordinalAge("1990-01-01", "2026-08-17") === 37);
ok("age across year rollover", ordinalAge("1990-01-01", "2026-12-25") === 37);
ok("implausible age returns null", ordinalAge("1800-01-01", "2026-08-17") === null);

// --- marker ids ----------------------------------------------------------
const markerId = (f, y, o) => `${f}#${y}#${o}`;
ok("marker is unique per offset", markerId("abc", 2026, 7) !== markerId("abc", 2026, 1));
ok("marker is unique per year", markerId("abc", 2026, 7) !== markerId("abc", 2027, 7));
ok("marker is stable", markerId("abc", 2026, 7) === markerId("abc", 2026, 7));

// --- window vs exact-match regression ------------------------------------
// The old in-app logic used === 7 only. A birthday 1 day out was invisible
// to it; the window catches all three checkpoints.
const offsets = [7, 1, 0];
ok("window catches day-of", offsets.includes(daysUntil("1990-08-17", "2026-08-17")));
ok("window catches tomorrow", offsets.includes(daysUntil("1990-08-18", "2026-08-17")));
ok("window ignores day 4", !offsets.includes(daysUntil("1990-08-21", "2026-08-17")));

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
