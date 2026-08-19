// Gift-query tests. Run with: node backend/gift-query.test.mjs
//
// The bug this guards: notes are freeform, and plenty of them are reminders to
// self rather than interests. Treating the first comma-segment as a search term
// turned a note reading "Delete this record later, this is just a test" into the
// store search "Delete this record later gift" -- which shipped to the UI and
// would have shipped in a reminder email.
//
// reminder.mjs imports the AWS SDK, which is not installed locally, so the pure
// gift helpers are extracted from source rather than imported.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "reminder.mjs"), "utf8");
const start = src.indexOf("const RELATION_QUERY");
const end = src.indexOf("\n}", src.indexOf("export function giftLinks")) + 2;
const chunk = src.slice(start, end).replace(/export function/g, "function");
const { giftQuery, giftLinks } = new Function(
  chunk + "\nreturn { giftQuery, giftLinks };"
)();

let pass = 0, fail = 0;
function is(actual, expected, label) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  expected: ${expected}\n  actual  : ${actual}`);
}
function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}`);
}

// --- the reported bug -----------------------------------------------------
is(giftQuery({ name: "Test", relation: "", notes: "Delete this record later, this is just a test" }),
   "birthday gift ideas",
   "a note-to-self must not become the search term");

is(giftQuery({ name: "TESTin", relation: "Friend", notes: "" }),
   "birthday gifts for friends",
   "relation drives the search when notes are empty");

// --- notes that SHOULD drive the search -----------------------------------
is(giftQuery({ relation: "Sister", notes: "loves pottery" }), "loves pottery gift",
   "a short interest wins over the relation");
is(giftQuery({ relation: "Friend", notes: "gardening, hiking" }), "gardening gift",
   "first item of a comma list is used");
is(giftQuery({ relation: "Brother", notes: "vinyl records" }), "vinyl records gift",
   "two-word interest is fine");

// --- notes that should NOT ------------------------------------------------
for (const [notes, why] of [
  ["check with mom about her address", "instruction to self"],
  ["TODO: confirm the date", "todo marker"],
  ["duplicate of the other entry", "record housekeeping"],
  ["She mentioned wanting new running shoes last spring", "a sentence, not a search term"],
  ["12345", "no letters"],
  ["   ", "whitespace only"],
]) {
  const q = giftQuery({ relation: "Friend", notes });
  is(q, "birthday gifts for friends", `notes ignored: ${why}`);
}

// --- relation mapping -----------------------------------------------------
is(giftQuery({ relation: "Mom" }), "gifts for mom", "Mom maps");
is(giftQuery({ relation: "Spouse" }), "romantic birthday gift", "Spouse maps");
is(giftQuery({ relation: "Best friend" }), "gifts for best friend", "multi-word relation maps");
is(giftQuery({ relation: "Dog walker" }), "dog walker gift", "unmapped relation still degrades usefully");

// --- last resort ----------------------------------------------------------
is(giftQuery({ name: "Alex" }), "birthday gift ideas",
   "no relation and no usable notes gives a searchable phrase, not the person's name");
is(giftQuery({}), "birthday gift ideas", "empty record never throws");

// --- links ----------------------------------------------------------------
const links = giftLinks({ relation: "Sister" });
is(links.length, 2, "two links");
ok(links[0].url.startsWith("https://www.etsy.com/search?q="), "etsy link shape");
ok(links[1].url.startsWith("https://www.amazon.com/s?k="), "amazon link shape");
ok(links.every(l => !/[ "']/.test(l.url)), "query is url-encoded");
ok(!links.some(l => /tag=|aff|utm_/i.test(l.url)), "no affiliate or tracking params");

console.log(`\n${pass} passing${fail ? `, ${fail} failing` : ""}`);
process.exit(fail ? 1 : 0);
