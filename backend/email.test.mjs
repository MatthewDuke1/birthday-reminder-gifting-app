// Tests for the reminder email, both parts.
//
// The thing worth guarding here is escaping. Names, relations and notes are
// freeform text typed by a person, and the HTML part interpolates all three.
// A friend recorded as `<img src=x onerror=...>` must arrive as visible text,
// not as markup, in every client that renders HTML mail.
//
// reminder.mjs imports the AWS SDK, which is not installed locally, so the
// module is loaded with the SDK lines stripped rather than mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "reminder.mjs"), "utf8");

const stripped = src
  .split("\n")
  .filter(l => !l.includes("@aws-sdk/"))
  .filter(l => !/^const (ddb|ses) = /.test(l))
  .join("\n") + "\nexport { buildEmail, escHtml, safeUrl };\n";

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bday-")), "reminder.test.mjs");
fs.writeFileSync(tmp, stripped);
const { buildEmail, escHtml, safeUrl } = await import(pathToFileURL(tmp).href);

let fail = 0;
const ok = (label, cond) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) fail++; };

const TODAY = "2026-03-01";

// --- escaping primitives -------------------------------------------------
ok("escapes angle brackets", escHtml("<b>") === "&lt;b&gt;");
ok("escapes quotes and ampersand", escHtml(`&"'`) === "&amp;&quot;&#39;");
ok("null becomes empty", escHtml(null) === "");
ok("passes http urls", safeUrl("https://example.com/x") === "https://example.com/x");
ok("rejects javascript urls", safeUrl("javascript:alert(1)") === "");
ok("rejects data urls", safeUrl("data:text/html,<script>") === "");

// --- a hostile record ----------------------------------------------------
const nasty = {
  friendId: "1",
  name: '<img src=x onerror="alert(1)">',
  relation: '"><script>alert(2)</script>',
  notes: "loves pottery & <b>ceramics</b>",
  birthday: "1990-03-08",
};
const hostile = buildEmail({ 7: [nasty] }, TODAY, "https://example.com/app");

ok("no raw script tag in html", !hostile.html.includes("<script>"));
ok("no raw img tag in html", !hostile.html.includes("<img src=x"));
ok("name is escaped", hostile.html.includes("&lt;img src=x"));
ok("relation is escaped", hostile.html.includes("&lt;script&gt;"));
ok("notes ampersand is escaped", hostile.html.includes("ceramics&lt;/b&gt;"));
// The literal text "onerror=" survives inside the escaped name, which is
// harmless. What must not survive is a real attribute, and a real one needs an
// unescaped quote after the equals sign.
ok("no live onerror attribute", !/onerror\s*=\s*["']/.test(hostile.html));
ok("hostile quotes are escaped", hostile.html.includes("onerror=&quot;"));

// --- a normal record -----------------------------------------------------
const groups = {
  0: [{ friendId: "a", name: "Ann Lee", relation: "Sister", birthday: "1992-03-01", notes: "loves pottery" }],
  1: [{ friendId: "b", name: "Bob Ray", relation: "Dad", birthday: "1960-03-02" }],
  7: [{ friendId: "c", name: "Cy Diaz", birthday: "1988-03-08" }],
};
const out = buildEmail(groups, TODAY, "https://example.com/app");

ok("returns all three parts", !!out.subject && !!out.body && !!out.html);
ok("html is a full document", out.html.startsWith("<!doctype html>"));
ok("subject summarises counts", out.subject === "Birthday reminder: 1 today, 1 tomorrow, 1 in 7 days");
ok("html shows every name", ["Ann Lee", "Bob Ray", "Cy Diaz"].every(n => out.html.includes(n)));
ok("html labels today", out.html.includes(">Today<"));
ok("html labels tomorrow", out.html.includes(">Tomorrow<"));
ok("html labels the 7-day window", out.html.includes(">In 7 days<"));
ok("html shows the computed age", out.html.includes("turning 34"));
ok("html carries the note", out.html.includes("loves pottery"));
ok("html links to Etsy and Amazon", out.html.includes("etsy.com/search") && out.html.includes("amazon.com/s?k="));
ok("html uses the notes-driven query", out.html.includes("loves pottery gift"));
ok("html uses the relation-driven query", out.html.includes("gifts for dad"));
ok("footer links to the app", out.html.includes('href="https://example.com/app"'));
ok("text part still plain", !out.body.includes("<") && out.body.includes("Birthdays today:"));

// --- the footer is optional ---------------------------------------------
const noUrl = buildEmail(groups, TODAY, "");
ok("no app link when APP_URL is unset", !noUrl.html.includes("Open your birthday list"));
ok("text part omits the footer too", !noUrl.body.includes("---"));

// --- one person reads as a sentence -------------------------------------
const single = buildEmail({ 0: [groups[0][0]] }, TODAY, "");
ok("single subject names the person", single.subject === "Birthday reminder: Ann Lee");
ok("single headline reads as a sentence", single.html.includes("Ann Lee has a birthday today"));

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
