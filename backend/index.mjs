// Birthday app API -- friends read/write.
//
// One Lambda behind an HTTP API. At two users and a few hundred writes a
// year, splitting this per-route would triple the deploy surface and buy
// nothing.
//
// Auth model: Cognito. The household signs in on Cognito's hosted page with
// an emailed one-time code, and API Gateway's JWT authorizer checks the
// access token before this function is ever invoked. The user pool is
// invite-only, so a valid token means one of the household's own accounts.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

// Every one of these comes from the CloudFormation stack. There are no
// defaults on purpose: a default table name or origin means a misconfigured
// deploy quietly reads and writes somebody else's stack instead of failing.
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const REGION = required("AWS_REGION");
const TABLE = required("TABLE_NAME");
const ORIGIN = required("ALLOWED_ORIGIN");
// Shared list: both users read and write the same partition. If these ever
// need to split, this becomes a per-user value and the data needs migrating.
const OWNER = "household";

const MAX_FRIENDS = 2000;                 // mirrors the client-side cap

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const headers = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Content-Type": "application/json",
  // /friends returns the whole list, so nothing here is safe to sit in a
  // shared cache.
  "Cache-Control": "no-store",
  "Vary": "Origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

// Re-validate on the way in. The client sanitises too, but a client-side
// check is a convenience, not a boundary.
function cleanFriend(f) {
  if (!f || typeof f !== "object") return null;
  const s = (v, n) => typeof v === "string" ? v.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, n) : "";
  const name = s(f.name, 100);
  const birthday = typeof f.birthday === "string" ? f.birthday.slice(0, 10) : "";
  if (!name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const y = +birthday.slice(0, 4);
  if (y < 1900 || y > 2099) return null;
  if (Number.isNaN(Date.parse(birthday + "T00:00:00Z"))) return null;
  return {
    name,
    email: s(f.email, 254),
    birthday,
    relation: s(f.relation, 40),
    notes: s(f.notes, 500),
    source: s(f.source, 20),
    // Card opt-in. Dropping these here meant the box ticked in the app never
    // reached the table, so the reminder could never send a card.
    hideAge: f.hideAge === true,
    sendCard: f.sendCard === true,
  };
}

async function readAll() {
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

// Whole-list replace. Last write wins: at two users who add birthdays
// occasionally, a simultaneous edit clobbering the other is an acceptable
// risk, and per-item conflict handling would roughly double this file.
async function writeAll(friends) {
  const existing = await readAll();
  const keep = new Set(friends.map(f => f.friendId));
  const dead = existing.filter(e => !keep.has(e.friendId));

  const ops = [
    ...dead.map(d => ({ DeleteRequest: { Key: { ownerId: OWNER, friendId: d.friendId } } })),
    ...friends.map(f => ({ PutRequest: { Item: { ownerId: OWNER, ...f } } })),
  ];

  for (let i = 0; i < ops.length; i += 25) {
    const chunk = ops.slice(i, i + 25);
    let req = { RequestItems: { [TABLE]: chunk } };
    // BatchWrite can partially fail under throttling; retry only what came back.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand(req));
      const un = res.UnprocessedItems?.[TABLE];
      if (!un || !un.length) break;
      req = { RequestItems: { [TABLE]: un } };
      await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers, body: "" };

  // API Gateway has already verified the token. Checking that its claims
  // arrived anyway means a route accidentally left without the authorizer
  // fails closed instead of serving the list to anyone.
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims || !claims.sub) return reply(401, { error: "not signed in" });

  if (path.endsWith("/friends") && method === "GET") {
    const items = await readAll();
    items.sort((a, b) => a.name.localeCompare(b.name));
    return reply(200, { friends: items });
  }

  if (path.endsWith("/friends") && method === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "bad json" }); }
    if (!Array.isArray(body.friends)) return reply(400, { error: "friends must be an array" });
    if (body.friends.length > MAX_FRIENDS) return reply(400, { error: "too many friends" });

    const seen = new Set();
    const clean = [];
    for (const f of body.friends) {
      const c = cleanFriend(f);
      if (!c) continue;
      const key = c.name.toLowerCase();
      if (seen.has(key)) continue;   // same dedupe rule the client uses
      seen.add(key);
      // Reuse the client's id when present so ids stay stable across syncs.
      clean.push({ ...c, friendId: typeof f.friendId === "string" && f.friendId ? f.friendId.slice(0, 64) : crypto.randomUUID() });
    }

    await writeAll(clean);
    return reply(200, { ok: true, count: clean.length });
  }

  return reply(404, { error: "no such route" });
};
