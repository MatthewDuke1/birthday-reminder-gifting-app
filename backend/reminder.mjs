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

const REGION = process.env.AWS_REGION || "us-west-2";
const TABLE = process.env.TABLE_NAME || "bdayapp-friends";
const FROM = process.env.FROM_ADDRESS || "matthewduke0@gmail.com";
const TO = (process.env.TO_ADDRESSES || "matthewduke0@gmail.com,msb9519@gmail.com")
  .split(",").map(s => s.trim()).filter(Boolean);

// Reminders are meaningful in local time -- "7 days before" should mean
// 7 calendar days where the household lives, not in UTC.
const TZ = process.env.TZ_NAME || "America/Chicago";

const OWNER = "household";
const SENT_PARTITION = "__sent";
const OFFSETS = [7, 1, 0];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = new SESClient({ region: REGION });

// "Today" in the household's timezone, as YYYY-MM-DD.
function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
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

async function loadFriends() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
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

async function alreadySent(id) {
  try {
    const out = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { ownerId: SENT_PARTITION, friendId: id },
    }));
    return !!out.Item;
  } catch (e) {
    console.error("alreadySent failed for", id, e.name, e.message);
    // Fail closed: if the marker cannot be read, skip rather than risk a
    // duplicate. A missed reminder is recoverable; spam erodes trust.
    return true;
  }
}

async function markSent(id) {
  const ttl = Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60;
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ownerId: SENT_PARTITION, friendId: id, sentAt: new Date().toISOString(), expiresAt: ttl },
  }));
}

function buildEmail(groups, todayStr) {
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
    }
    lines.push("");
    subjects.push(`${list.length} ${when}`);
  }

  const allNames = OFFSETS.flatMap(o => (groups[o] || []).map(f => f.name));
  const subject = allNames.length === 1
    ? `Birthday reminder: ${allNames[0]}`
    : `Birthday reminder: ${subjects.join(", ")}`;

  lines.push("---");
  lines.push("https://matthewduke1.github.io/birthday-reminder-gifting-app/");

  return { subject: subject.slice(0, 200), body: lines.join("\n") };
}

export const handler = async () => {
  const todayStr = localToday();
  const year = Number(todayStr.slice(0, 4));
  const friends = await loadFriends();

  const groups = {};
  const toMark = [];

  for (const f of friends) {
    if (!f.birthday || !f.friendId) continue;
    const d = daysUntil(f.birthday, todayStr);
    if (!OFFSETS.includes(d)) continue;
    const id = markerId(f.friendId, year, d);
    if (await alreadySent(id)) continue;
    (groups[d] ||= []).push(f);
    toMark.push(id);
  }

  if (!toMark.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, date: todayStr, reason: "nothing due" }) };
  }

  const { subject, body } = buildEmail(groups, todayStr);

  await ses.send(new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: TO },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Text: { Data: body, Charset: "UTF-8" } },
    },
  }));

  // Only mark after SES accepts. If the send throws, nothing is marked and
  // tomorrow's run retries -- the window is what makes that recovery work.
  for (const id of toMark) await markSent(id);

  return { statusCode: 200, body: JSON.stringify({ sent: toMark.length, date: todayStr, subject }) };
};
