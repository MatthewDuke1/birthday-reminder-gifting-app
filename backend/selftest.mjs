// Quick self-test for the API's input sanitiser. Not a full test suite --
// just enough to catch the thing that silently breaks: the control-character
// strip. (Sign-in moved to Cognito, so there is no password or token code
// left in the API to test here.)

let fail = 0;
const ok = (label, cond) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) fail++; };

// --- sanitiser -----------------------------------------------------------
  const s = (v, n) => typeof v === "string" ? v.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, n) : "";

// Built via String.fromCharCode so the control bytes cannot be flattened by
// an editor, a copy-paste, or a shell round trip -- which is exactly how
// these two assertions were silently neutered once already.
const NUL = String.fromCharCode(1), DEL = String.fromCharCode(127);
ok("strips control chars", s("Bob" + NUL + " Smith", 100) === "Bob Smith");
ok("strips DEL", s("A" + DEL + "B", 100) === "AB");
ok("strips newline and tab", s("A" + String.fromCharCode(10) + String.fromCharCode(9) + "B", 100) === "AB");
ok("trims whitespace", s("   Ann   ", 100) === "Ann");
ok("truncates to n", s("abcdefghij", 4) === "abcd");
ok("non-string returns empty", s(null, 100) === "");
ok("keeps normal names", s("Mary-Jane O'Neil", 100) === "Mary-Jane O'Neil");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
