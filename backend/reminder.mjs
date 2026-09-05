// Daily birthday reminder.
//
// Runs on an EventBridge schedule with no browser open -- which is the whole
// reason the data had to leave localStorage. The old in-app sendHeadsUp()
// only fired when somebody happened to click a button on exactly the right
// day, which is not a reminder.
//
// Fires on a WINDOW (7 days out, 1 day out, and the day itself) rather than
// a single exact-match offset. Exact match silently misses a birthday
// entirely if the scheduler has one bad morning; a window plus a sent-marker
// gives the run a second chance without ever double-sending.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Config is resolved lazily so the pure helpers below stay importable and
// testable without a configured environment.
//
// The defaults that used to sit here were this repo author's own table, own
// sender and own inbox. In someone else's account that is not a convenience:
// a half-configured stack would mail another household's birthdays to a
// stranger. Missing config is now a loud failure instead of a silent one.
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("missing required env var " + name);
  return v;
}

const REGION = process.env.AWS_REGION || "us-east-1";

function config() {
  const to = required("TO_ADDRESSES").split(",").map(s => s.trim()).filter(Boolean);
  if (!to.length) throw new Error("TO_ADDRESSES is set but empty");
  return {
    table: required("TABLE_NAME"),
    from: required("FROM_ADDRESS"),
    to,
    // Reminders are meaningful in local time -- "7 days before" should mean
    // 7 calendar days where the household lives, not in UTC.
    tz: process.env.TZ_NAME || "America/Chicago",
    // Footer link. No default: pointing every deployment back at the author's
    // Pages site is both wrong and a quiet outbound signal.
    appUrl: process.env.APP_URL || "",
  };
}

const OWNER = "household";
const SENT_PARTITION = "__sent";
const OFFSETS = [7, 1, 0];
// Matching only cares that an offset is in the set. Reading order is a
// separate concern: the birthday that is today belongs at the top of the mail,
// not underneath the one a week out.
const DISPLAY_OFFSETS = [0, 1, 7];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = new SESClient({ region: REGION });

// "Today" in the household's timezone, as YYYY-MM-DD.
function localToday(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Whole calendar days from today until the next occurrence of a birthday,
// ignoring the birth year. Computed on UTC-noon anchors so a DST shift
// cannot round the difference to the wrong day.
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

const fmtDate = b => {
  const [, m, d] = b.split("-").map(Number);
  return new Date(Date.UTC(2000, m - 1, d)).toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
};

// ── Gift search ──────────────────────────────────────────────────────────
// The reminder is the moment you actually want to buy something, so the email
// carries the shopping links rather than making you open the app to get them.
//
// The query is driven by how the person is filed. Notes win when present --
// "loves pottery" is a far better search than "Sister" -- then the relation,
// then the bare name as a last resort.

// A relation on its own is a weak search term, so map the common ones to
// something a store can actually match. Anything unmapped falls through to
// "<relation> gift", which is still better than the person's name.
const RELATION_QUERY = {
  mom: "gifts for mom",
  dad: "gifts for dad",
  sister: "gifts for sister",
  brother: "gifts for brother",
  grandmother: "gifts for grandma",
  grandfather: "gifts for grandpa",
  aunt: "gifts for aunt",
  uncle: "gifts for uncle",
  cousin: "birthday gifts for cousin",
  spouse: "romantic birthday gift",
  girlfriend: "gifts for girlfriend",
  boyfriend: "gifts for boyfriend",
  partner: "romantic birthday gift",
  "fiancée": "engagement birthday gift",
  "fiance": "engagement birthday gift",
  "fiancé": "engagement birthday gift",
  "best friend": "gifts for best friend",
  friend: "birthday gifts for friends",
  colleague: "coworker birthday gift",
  roommate: "roommate birthday gift",
  "neighbour": "neighbor gift",
  neighbor: "neighbor gift",
};

// Pure: the search phrase for one person.
// Words that mean the note is about the RECORD, not about the person. A note
// like "delete this later" or "check with mom re: address" is a reminder to
// self, and pasting it into a store search produces nonsense.
const NOTE_NOISE = /\b(delete|remove|test|testing|todo|to-do|fixme|temp|temporary|dupe|duplicate|placeholder|ignore|check|verify|confirm|update|fix|wrong|unsure|not sure|maybe|tbd|n\/a)\b/i;

// A usable gift hint is a short phrase about the person's interests. Anything
// long enough to be a sentence is almost certainly context, not a search term.
function giftHintFromNotes(notes) {
  const raw = (notes || "").trim();
  if (!raw) return "";
  const first = raw.split(/[,;\n]/)[0].trim();
  if (!first) return "";
  if (NOTE_NOISE.test(first)) return "";           // a note to self, not an interest
  if (first.split(/\s+/).length > 4) return "";    // a sentence, not a search term
  if (first.length > 40) return "";
  if (!/[a-z]/i.test(first)) return "";            // no letters, nothing to search
  return first;
}

export function giftQuery(f) {
  // Notes win only when they actually read like an interest. They are freeform,
  // so plenty of them are reminders to self -- "Delete this record later" became
  // the search "Delete this record later gift", which is worse than useless.
  const hint = giftHintFromNotes(f.notes);
  if (hint) return `${hint} gift`;

  const rel = (f.relation || "").trim().toLowerCase();
  if (rel) return RELATION_QUERY[rel] || `${rel} gift`;
  return "birthday gift ideas";
}

// Pure: the shopping links for one person. Search URLs, not affiliate links --
// nothing here tracks the user or earns a commission.
export function giftLinks(f) {
  const q = encodeURIComponent(giftQuery(f));
  return [
    { label: "Etsy",   url: `https://www.etsy.com/search?q=${q}` },
    { label: "Amazon", url: `https://www.amazon.com/s?k=${q}` },
  ];
}

async function loadFriends(table) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": OWNER },
      ExclusiveStartKey,
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// One marker per friend per year per offset. A Lambda retry, a double
// EventBridge fire, or a manual re-run all become no-ops rather than a
// second identical email.
const markerId = (friendId, year, offset) => `${friendId}#${year}#${offset}`;

async function alreadySent(table, id) {
  try {
    const out = await ddb.send(new GetCommand({
      TableName: table, Key: { ownerId: SENT_PARTITION, friendId: id },
    }));
    return !!out.Item;
  } catch (e) {
    console.error("alreadySent failed for", id, e.name, e.message);
    // Fail closed: if the marker cannot be read, skip rather than risk a
    // duplicate. A missed reminder is recoverable; spam erodes trust.
    return true;
  }
}

async function markSent(table, id) {
  const ttl = Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60;
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { ownerId: SENT_PARTITION, friendId: id, sentAt: new Date().toISOString(), expiresAt: ttl },
  }));
}

// ── Email rendering ──────────────────────────────────────────────────────
// Names, relations and notes are typed by a person and stored verbatim, so
// every one of them is escaped before it goes near the HTML part. A friend
// named `<img src=x onerror=...>` is a rendering bug at best in a mail client
// that runs it, and a phishing surface at worst.
const escHtml = v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Only http(s) URLs are ever emitted as hrefs. giftLinks builds these from
// encodeURIComponent, so this is a belt-and-braces guard against a javascript:
// or data: URL ever reaching an anchor.
const safeUrl = u => /^https?:\/\//i.test(String(u)) ? String(u) : "";

const WHEN_LABEL = { 0: "Today", 1: "Tomorrow" };
const whenLabel = o => WHEN_LABEL[o] || `In ${o} days`;
const whenPhrase = o => o === 0 ? "today" : o === 1 ? "tomorrow" : `in ${o} days`;

// Palette. Kept as constants because every one of these is repeated inline --
// mail clients strip <style> blocks often enough that inline is the only
// reliable option, and Outlook's renderer ignores most of a stylesheet anyway.
const C = {
  ink: "#1a1a1a", ink2: "#57534e", ink3: "#8a8580",
  line: "#e7e2dc", card: "#ffffff", page: "#f5f2ee",
  accent: "#b4532a", accentSoft: "#fdf5f0",
};

function personRow(f, todayStr) {
  const age = ordinalAge(f.birthday, todayStr);
  const name = escHtml(f.name);
  const rel = f.relation ? escHtml(f.relation) : "";
  const date = escHtml(fmtDate(f.birthday));
  const query = escHtml(giftQuery(f));

  const meta = [date];
  if (age) meta.push(`turning ${age}`);

  const buttons = giftLinks(f)
    .map(l => safeUrl(l.url) ? `<a href="${escHtml(safeUrl(l.url))}" style="display:inline-block;padding:8px 14px;margin:0 8px 0 0;background:${C.accentSoft};border:1px solid ${C.line};border-radius:6px;color:${C.accent};font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-decoration:none;">${escHtml(l.label)} &rarr;</a>` : "")
    .join("");

  return `
      <tr>
        <td style="padding:16px 20px;border-top:1px solid ${C.line};">
          <div style="font:600 16px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};">
            ${name}${rel ? ` <span style="font:400 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink3};">${rel}</span>` : ""}
          </div>
          <div style="margin-top:3px;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink2};">
            ${escHtml(meta.join(" \u00b7 "))}
          </div>
          ${f.notes ? `<div style="margin-top:8px;padding:8px 10px;background:${C.page};border-radius:5px;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink2};">${escHtml(f.notes)}</div>` : ""}
          <div style="margin-top:12px;">
            <div style="margin-bottom:7px;font:400 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink3};letter-spacing:.06em;text-transform:uppercase;">Gift ideas for &ldquo;${query}&rdquo;</div>
            ${buttons}
          </div>
        </td>
      </tr>`;
}

function buildHtml(groups, todayStr, appUrl, headline) {
  const sections = DISPLAY_OFFSETS.map(offset => {
    const list = groups[offset];
    if (!list || !list.length) return "";
    const rows = list.map(f => personRow(f, todayStr)).join("");
    return `
      <tr>
        <td style="padding:20px 20px 4px;">
          <span style="display:inline-block;padding:4px 10px;border-radius:2em;background:${offset === 0 ? C.accent : C.page};color:${offset === 0 ? "#ffffff" : C.ink2};font:600 11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:.07em;text-transform:uppercase;">${escHtml(whenLabel(offset))}</span>
        </td>
      </tr>${rows}`;
  }).join("");

  const footer = appUrl && safeUrl(appUrl)
    ? `<a href="${escHtml(safeUrl(appUrl))}" style="color:${C.ink3};text-decoration:underline;">Open your birthday list</a>`
    : "Sent by your own birthday reminder stack.";

  // A table-based, fixed-width layout with inline styles: the only thing that
  // survives Outlook, Gmail and Apple Mail without three separate hacks.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escHtml(headline)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(headline)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:10px;overflow:hidden;">
          <tr>
            <td style="padding:22px 20px 18px;">
              <div style="font:400 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink3};letter-spacing:.1em;text-transform:uppercase;">Birthday reminder</div>
              <div style="margin-top:7px;font:600 20px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};">${escHtml(headline)}</div>
            </td>
          </tr>${sections}
          <tr>
            <td style="padding:16px 20px 20px;border-top:1px solid ${C.line};font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink3};">
              ${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmail(groups, todayStr, appUrl) {
  const lines = [];
  const subjects = [];

  for (const offset of DISPLAY_OFFSETS) {
    const list = groups[offset];
    if (!list || !list.length) continue;
    const when = whenPhrase(offset);
    lines.push(offset === 0 ? "Birthdays today:" : `Birthdays ${when}:`);
    for (const f of list) {
      const age = ordinalAge(f.birthday, todayStr);
      const bits = [f.name];
      if (f.relation) bits.push(`(${f.relation})`);
      bits.push("-", fmtDate(f.birthday));
      if (age) bits.push(`- turning ${age}`);
      lines.push("  " + bits.join(" "));
      if (f.notes) lines.push(`    note: ${f.notes}`);
      // Shopping links, so the reminder is actionable from the inbox.
      lines.push(`    gift ideas ("${giftQuery(f)}"):`);
      for (const l of giftLinks(f)) lines.push(`      ${l.label}: ${l.url}`);
    }
    lines.push("");
    subjects.push(`${list.length} ${when}`);
  }

  const allNames = DISPLAY_OFFSETS.flatMap(o => (groups[o] || []).map(f => f.name));
  const subject = allNames.length === 1
    ? `Birthday reminder: ${allNames[0]}`
    : `Birthday reminder: ${subjects.join(", ")}`;

  // Headline for the HTML part: says the same thing as the subject, but reads
  // as a sentence rather than a summary line.
  const headline = allNames.length === 1
    ? `${allNames[0]} has a birthday ${whenPhrase(DISPLAY_OFFSETS.find(o => (groups[o] || []).length))}`
    : `${allNames.length} birthdays coming up`;

  if (appUrl) {
    lines.push("---");
    lines.push(appUrl);
  }

  return {
    subject: subject.slice(0, 200),
    body: lines.join("\n"),
    html: buildHtml(groups, todayStr, appUrl, headline),
  };
}

export const handler = async () => {
  const cfg = config();
  const todayStr = localToday(cfg.tz);
  const year = Number(todayStr.slice(0, 4));
  const friends = await loadFriends(cfg.table);

  const groups = {};
  const toMark = [];

  for (const f of friends) {
    if (!f.birthday || !f.friendId) continue;
    const d = daysUntil(f.birthday, todayStr);
    if (!OFFSETS.includes(d)) continue;
    const id = markerId(f.friendId, year, d);
    if (await alreadySent(cfg.table, id)) continue;
    (groups[d] ||= []).push(f);
    toMark.push(id);
  }

  if (!toMark.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, date: todayStr, reason: "nothing due" }) };
  }

  const { subject, body, html } = buildEmail(groups, todayStr, cfg.appUrl);

  await ses.send(new SendEmailCommand({
    Source: cfg.from,
    Destination: { ToAddresses: cfg.to },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: body, Charset: "UTF-8" },
        Html: { Data: html, Charset: "UTF-8" },
      },
    },
  }));

  // Only mark after SES accepts. If the send throws, nothing is marked and
  // tomorrow's run retries -- the window is what makes that recovery work.
  for (const id of toMark) await markSent(cfg.table, id);

  return { statusCode: 200, body: JSON.stringify({ sent: toMark.length, date: todayStr, subject }) };
};
