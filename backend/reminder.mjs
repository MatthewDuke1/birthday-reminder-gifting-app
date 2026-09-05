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

function buildEmail(groups, todayStr, appUrl) {
  const lines = [];
  const subjects = [];

  for (const offset of OFFSETS) {
    const list = groups[offset];
    if (!list || !list.length) continue;
    const when = offset === 0 ? "today" : offset === 1 ? "tomorrow" : `in ${offset} days`;
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

  const allNames = OFFSETS.flatMap(o => (groups[o] || []).map(f => f.name));
  const subject = allNames.length === 1
    ? `Birthday reminder: ${allNames[0]}`
    : `Birthday reminder: ${subjects.join(", ")}`;

  if (appUrl) {
    lines.push("---");
    lines.push(appUrl);
  }

  return { subject: subject.slice(0, 200), body: lines.join("\n") };
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

  const { subject, body } = buildEmail(groups, todayStr, cfg.appUrl);

  await ses.send(new SendEmailCommand({
    Source: cfg.from,
    Destination: { ToAddresses: cfg.to },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Text: { Data: body, Charset: "UTF-8" } },
    },
  }));

  // Only mark after SES accepts. If the send throws, nothing is marked and
  // tomorrow's run retries -- the window is what makes that recovery work.
  for (const id of toMark) await markSent(cfg.table, id);

  return { statusCode: 200, body: JSON.stringify({ sent: toMark.length, date: todayStr, subject }) };
};
