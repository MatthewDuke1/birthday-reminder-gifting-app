// Birthday app API -- auth + friends read/write.
//
// One Lambda behind an HTTP API. At two users and a few hundred writes a
// year, splitting this per-route would triple the deploy surface and buy
// nothing.
//
// Auth model: a single shared household password. The browser POSTs it to
// /auth, we compare against a scrypt hash held in SSM, and hand back an
// HMAC-signed token. The static page never holds a secret -- a password
// checked in browser JS is not a check at all, since anyone can view source.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
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
// Secrets live under /<stack-name>/, and the execution role is scoped to that
// same prefix. Hard-coding it broke every stack not literally named "bdayapp":
// the role could not read /bdayapp/* and the app returned "config unavailable".
const SSM_PREFIX = required("SSM_PREFIX").replace(/\/+$/, "");

// Shared list: both users read and write the same partition. If these ever
// need to split, this becomes a per-user value and the data needs migrating.
const OWNER = "household";

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;  // 30 days
const MAX_FRIENDS = 2000;                 // mirrors the client-side cap

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ssm = new SSMClient({ region: REGION });

// SSM is read once per container and cached. Lambda reuses warm containers,
// so this is typically one call per cold start rather than one per request.
let _secrets = null;
async function secrets() {
  if (_secrets) return _secrets;
  const hashName = `${SSM_PREFIX}/password-hash`;
  const jwtName = `${SSM_PREFIX}/jwt-secret`;
  const out = await ssm.send(new GetParametersCommand({
    Names: [hashName, jwtName],
    WithDecryption: true,
  }));
  const byName = Object.fromEntries((out.Parameters || []).map(p => [p.Name, p.Value]));
  const hash = byName[hashName];
  const jwt = byName[jwtName];
  // GetParameters reports unknown names in InvalidParameters rather than
  // throwing, so an absent secret would otherwise surface as "undefined" and
  // be compared against - which fails open on a falsy hash.
  if (!hash || !jwt) throw new Error("app secrets missing under " + SSM_PREFIX);
  _secrets = { hash, jwt };
  return _secrets;
}

const b64u = buf => Buffer.from(buf).toString("base64url");

function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret).update(body).digest();
  return body + "." + b64u(mac);
}

function verifyToken(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = b64u(crypto.createHmac("sha256", secret).update(body).digest());
  // timingSafeEqual throws on length mismatch, so guard before comparing.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
  // A signature proves the token came from us; it does not prove what it is
  // for. Pin the subject so a token minted for anything else is not accepted
  // here just because the same signing key produced it.
  if (payload.sub !== OWNER) return null;
  // Reject an absurd lifetime even if correctly signed, so a token issued by
  // an older build with a longer TTL cannot outlive the current policy.
  if (typeof payload.iat === "number" && payload.exp - payload.iat > TOKEN_TTL_SEC) return null;
  return payload;
}

// scrypt$<salt>$<hash>. Constant-time compare so a wrong password cannot be
// narrowed down by timing the response.
function checkPassword(pw, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, want] = parts;
  const got = crypto.scryptSync(pw, salt, 64).toString("hex");
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const headers = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Content-Type": "application/json",
  // /auth hands back a bearer token and /friends returns the whole list, so
  // nothing here is safe to sit in a shared cache.
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

// ── Brute-force lockout ──────────────────────────────────────────────────
// Failure counters live in the same table under a reserved partition, so
// there is nothing extra to provision and DynamoDB TTL sweeps them for
// free. Keyed by source IP: crude, but the realistic threat here is a
// script hammering one endpoint, not a distributed attack on a household
// birthday list.
const MAX_ATTEMPTS = 8;
const LOCKOUT_MIN = 15;
const AUTH_PARTITION = "__authfail";

async function checkLockout(ip) {
  try {
    const out = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { ownerId: AUTH_PARTITION, friendId: ip },
    }));
    const rec = out.Item;
    if (!rec) return { locked: false };
    if ((rec.count || 0) < MAX_ATTEMPTS) return { locked: false };
    const until = rec.lockedUntil || 0;
    const now = Math.floor(Date.now() / 1000);
    if (until > now) return { locked: true, retryMins: Math.ceil((until - now) / 60) };
    // Lockout expired -- wipe the slate so the next attempt starts clean.
    await clearFailures(ip);
    return { locked: false };
  } catch {
    // Never let a counter failure block a legitimate sign-in.
    return { locked: false };
  }
}

async function recordFailure(ip) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { ownerId: AUTH_PARTITION, friendId: ip },
      UpdateExpression: "SET #c = if_not_exists(#c, :z) + :one, lockedUntil = :until, expiresAt = :ttl",
      ExpressionAttributeNames: { "#c": "count" },
      ExpressionAttributeValues: {
        ":z": 0, ":one": 1,
        ":until": now + LOCKOUT_MIN * 60,
        ":ttl": now + 24 * 60 * 60,
      },
      ReturnValues: "UPDATED_NEW",
    }));
    return out.Attributes?.count || 0;
  } catch { return 0; }
}

async function clearFailures(ip) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { ownerId: AUTH_PARTITION, friendId: ip },
    }));
  } catch {}
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";

  if (method === "OPTIONS") return { statusCode: 204, headers, body: "" };

  let sec;
  try { sec = await secrets(); }
  catch { return reply(500, { error: "config unavailable" }); }

  if (path.endsWith("/auth") && method === "POST") {
    // API Gateway throttling caps request *rate*, which does nothing against
    // a slow, patient guesser. This counts failures per source IP and locks
    // the address out for a while once it crosses the threshold.
    const ip = String(event.requestContext?.http?.sourceIp || "unknown").slice(0, 45);
    const gate = await checkLockout(ip);
    if (gate.locked) {
      return reply(429, { error: `Too many attempts. Try again in ${gate.retryMins} minute${gate.retryMins === 1 ? "" : "s"}.` });
    }

    let pw = "";
    try { pw = JSON.parse(event.body || "{}").password || ""; } catch {}
    if (!pw || !checkPassword(pw, sec.hash)) {
      const after = await recordFailure(ip);
      const left = Math.max(0, MAX_ATTEMPTS - after);
      return reply(401, {
        error: "wrong password",
        ...(left <= 2 ? { warning: `${left} attempt${left === 1 ? "" : "s"} left before lockout.` } : {}),
      });
    }
    await clearFailures(ip);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + TOKEN_TTL_SEC;
    return reply(200, { token: sign({ sub: OWNER, iat, exp }, sec.jwt), exp });
  }

  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const claims = verifyToken(auth.replace(/^Bearer\s+/i, ""), sec.jwt);
  if (!claims) return reply(401, { error: "not signed in" });

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
