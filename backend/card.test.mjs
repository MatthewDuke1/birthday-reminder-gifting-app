// Birthday-card tests. The risks here are ordinals (11th/21st/13th), the
// hideAge opt-out actually suppressing the age everywhere, and the plain-text
// part staying readable on its own.
// reminder.mjs imports the AWS SDK at module scope, so - matching
// email.test.mjs - it is loaded with those lines stripped rather than mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "reminder.mjs"), "utf8");
const NL = String.fromCharCode(10);
const stripped = src
  .split(/\r?\n/)
  .filter(l => !l.includes("@aws-sdk/"))
  .filter(l => !/^const (ddb|ses) = /.test(l))
  .join(NL);

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bday-card-")), "reminder.test.mjs");
fs.writeFileSync(tmp, stripped);
const { buildCard } = await import(pathToFileURL(tmp).href);

let fail = 0;
const ok = (label, cond) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) fail++; };

const F = (over = {}) => ({ name: "Sarah", birthday: "1995-09-12", ...over });

// Turning 31 on the day itself.
let c = buildCard(F(), "2026-09-12", "Matt");
ok("subject carries the ordinal age", c.subject === "Happy 31st Birthday, Sarah 🎂");
ok("html greets with the ordinal", c.html.includes("Happy 31st Birthday"));
ok("text greets with the ordinal", c.text.startsWith("Happy 31st Birthday, Sarah!"));
ok("signs with the configured name", c.text.includes("— Matt"));

// Ordinal edge cases -- 11/12/13 are th, not st/nd/rd.
const sub = (b, t) => buildCard(F({ birthday: b }), t, "").subject;
ok("11th not 11st", sub("2015-09-12", "2026-09-12").includes("11th"));
ok("21st", sub("2005-09-12", "2026-09-12").includes("21st"));
ok("22nd", sub("2004-09-12", "2026-09-12").includes("22nd"));
ok("23rd", sub("2003-09-12", "2026-09-12").includes("23rd"));
ok("13th not 13rd", sub("2013-09-12", "2026-09-12").includes("13th"));

// hideAge must suppress it in every part, not just the subject.
c = buildCard(F({ hideAge: true }), "2026-09-12", "Matt");
ok("hideAge drops age from subject", c.subject === "Happy Birthday, Sarah 🎂");
ok("hideAge drops age from html", !c.html.includes("31"));
ok("hideAge drops age from text", !c.text.includes("31"));

// No FROM_NAME configured: no dangling em dash, no "runs" fragment.
c = buildCard(F(), "2026-09-12", "");
ok("unsigned card has no empty signoff", !c.text.includes("—"));
ok("unsigned footer stays grammatical", c.text.includes("a birthday reminder."));

// Escaping: a name with markup must not reach the html raw.
c = buildCard(F({ name: "<b>Bob</b>" }), "2026-09-12", "Matt");
ok("name is escaped in html", c.html.includes("&lt;b&gt;Bob&lt;/b&gt;") && !c.html.includes("<b>Bob</b>"));

// Both MIME parts must exist -- text-only clients get the fallback.
c = buildCard(F(), "2026-09-12", "Matt");
ok("has both parts", c.text.length > 40 && c.html.includes("<table"));

console.log(fail ? `\n${fail} failing` : "\nall passed");
process.exit(fail ? 1 : 0);
