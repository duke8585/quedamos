// Quedamos API. Everything outside /api/* is served from ./public by the assets binding.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOTS_RE = /^[012]*$/;
const SLOT_SIZES = [15, 30, 60, 90, 120, 180];
const MAX_DAYS = 62;
const MAX_LOOKUP = 50;
const MAX_VERSIONS = 100;
const MERGE_EDITS_MS = 15 * 60_000; // saves of the same answer within this window update one version
const HINT_AFTER = 3; // wrong admin passwords before the masked hint is revealed
const PBKDF2_ITERATIONS = 100_000; // Workers caps PBKDF2 at 100k
const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/l/I

// Sent with every API response so open tabs notice a new deploy and offer a reload.
let appVersion = "";

// `code` (+ `params`) lets the frontend show the message in the user's language; `message` stays English.
class HttpError extends Error {
  constructor(status, message, code, params) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    appVersion = env.CF_VERSION_METADATA?.id || "";
    try {
      return await route(request, env.DB, url.pathname.slice(4).split("/").filter(Boolean));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code, params: err.params }, err.status);
      console.error(err);
      return json({ error: "Internal error", code: "internal" }, 500);
    }
  },
};

async function route(request, db, parts) {
  const m = request.method;
  const [root, eventId, sub, subId, action] = parts;
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (root !== "events") throw new HttpError(404, "Not found", "notFound");

  if (parts.length === 1 && m === "POST") return createEvent(db, await body(request));
  if (parts.length === 1 && m === "GET") return lookupEvents(db, new URL(request.url).searchParams.get("ids"));
  if (parts.length === 2 && m === "GET") return getEvent(db, eventId);
  if (sub === "verify" && parts.length === 3 && m === "POST") return verifyEvent(db, eventId, await body(request), ip);
  if (sub === "archive" && parts.length === 3 && m === "POST") return archiveEvent(db, eventId, await body(request), ip);
  if (sub === "responses") {
    if (parts.length === 3 && m === "POST") return saveResponse(db, eventId, null, await body(request), ip);
    if (parts.length === 4 && m === "PUT") return saveResponse(db, eventId, subId, await body(request), ip);
    if (parts.length === 4 && m === "DELETE") return deleteResponse(db, eventId, subId, await body(request), ip);
  }
  if (sub === "versions") {
    if (parts.length === 3 && m === "GET") return listVersions(db, eventId);
    if (parts.length === 4 && m === "GET") return getVersion(db, eventId, subId);
    if (parts.length === 5 && action === "restore" && m === "POST") return restoreVersion(db, eventId, subId, await body(request), ip);
  }
  throw new HttpError(404, "Not found", "notFound");
}

// ---------- handlers ----------

async function createEvent(db, input) {
  const name = requireText(input.name, "Event name", "eventName", 200);
  const days = Array.isArray(input.days) ? [...new Set(input.days)] : [];
  if (!days.length) throw new HttpError(400, "Pick at least one day", "noDays");
  if (days.length > MAX_DAYS) throw new HttpError(400, `At most ${MAX_DAYS} days`, "tooManyDays", { max: MAX_DAYS });
  if (!days.every((d) => typeof d === "string" && DATE_RE.test(d))) {
    throw new HttpError(400, "Invalid date", "badRequest");
  }
  days.sort();

  const slotMinutes = Number(input.slotMinutes);
  const startMinute = Number(input.startMinute);
  const endMinute = Number(input.endMinute);
  if (!SLOT_SIZES.includes(slotMinutes)) throw new HttpError(400, "Invalid slot size", "badRequest");
  if (
    !Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 ||
    endMinute <= startMinute || startMinute % 15 || endMinute % 15
  ) {
    throw new HttpError(400, "End time must be after start time", "badTimes");
  }
  if ((endMinute - startMinute) % slotMinutes) {
    throw new HttpError(400, "The time window must be a multiple of the slot size", "slotFit", { slot: slotMinutes });
  }
  const timezone = validTimezone(input.timezone) ? input.timezone : "UTC";
  const adminPassword = input.adminPassword ? String(input.adminPassword) : "";

  const id = newId(10);
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO events (id, name, kind, days, start_minute, end_minute, slot_minutes, timezone,
         admin_password_hash, admin_password_hint, created_at, updated_at)
       VALUES (?, ?, 'dates', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, name, JSON.stringify(days), startMinute, endMinute, slotMinutes, timezone,
      adminPassword ? await hashPassword(adminPassword) : null, adminPassword ? passwordHint(adminPassword) : null, now, now,
    )
    .run();
  await addVersion(db, id, "created");
  return json({ id }, 201);
}

async function getEvent(db, eventId) {
  const event = await loadEvent(db, eventId);
  const { results } = await db
    .prepare("SELECT id, name, slots, updated_at FROM responses WHERE event_id = ? ORDER BY created_at")
    .bind(eventId)
    .all();
  return json({
    event: {
      id: event.id,
      name: event.name,
      days: JSON.parse(event.days),
      startMinute: event.start_minute,
      endMinute: event.end_minute,
      slotMinutes: event.slot_minutes,
      timezone: event.timezone,
      hasAdminPassword: !!event.admin_password_hash,
      archived: !!event.archived_at,
      createdAt: event.created_at,
    },
    responses: results.map((r) => ({ id: r.id, name: r.name, slots: r.slots, updatedAt: r.updated_at })),
  });
}

// Name + status for the "your recent events" list on the home page (ids come from localStorage).
async function lookupEvents(db, ids) {
  const list = [...new Set((ids || "").split(",").filter(Boolean))].slice(0, MAX_LOOKUP);
  if (!list.length) return json({ events: [] });
  const { results } = await db
    .prepare(
      `SELECT id, name, admin_password_hash IS NOT NULL AS has_admin_password, archived_at FROM events
       WHERE id IN (${list.map(() => "?").join(",")})`,
    )
    .bind(...list)
    .all();
  return json({
    events: results.map((e) => ({ id: e.id, name: e.name, hasAdminPassword: !!e.has_admin_password, archived: !!e.archived_at })),
  });
}

async function verifyEvent(db, eventId, { adminPassword }, ip) {
  const event = await loadEvent(db, eventId);
  if (!event.admin_password_hash) throw new HttpError(400, "This event has no admin password", "noPassword");
  await requireAdmin(db, event, adminPassword, ip);
  return json({ success: true });
}

async function archiveEvent(db, eventId, { adminPassword, archived }, ip) {
  const event = await loadEvent(db, eventId);
  if (!event.admin_password_hash) throw new HttpError(400, "This event has no admin password", "noPassword");
  await requireAdmin(db, event, adminPassword, ip);
  const now = nowIso();
  await db.prepare("UPDATE events SET archived_at = ?, updated_at = ? WHERE id = ?").bind(archived ? now : null, now, eventId).run();
  return json({ archived: !!archived });
}

// POST creates (409 if the name is taken, so nobody overwrites someone else by accident); PUT updates by id.
async function saveResponse(db, eventId, responseId, input, ip) {
  const event = await loadEvent(db, eventId);
  requireOpen(event);
  if (responseId) await requireEditRight(db, event, responseId, input, ip);
  const name = requireText(input.name, "Name", "name", 100);
  const slots = String(input.slots ?? "");
  const expected = JSON.parse(event.days).length * ((event.end_minute - event.start_minute) / event.slot_minutes);
  if (!SLOTS_RE.test(slots) || slots.length !== expected) throw new HttpError(400, "Invalid availability", "badRequest");

  const taken = await db
    .prepare("SELECT id FROM responses WHERE event_id = ? AND name = ? AND id IS NOT ?")
    .bind(eventId, name, responseId)
    .first();
  if (taken) throw new HttpError(409, `"${name}" already answered`, "nameTaken", { name, id: taken.id });

  const now = nowIso();
  let editToken;
  if (responseId) {
    const res = await db
      .prepare("UPDATE responses SET name = ?, slots = ?, updated_at = ? WHERE id = ? AND event_id = ?")
      .bind(name, slots, now, responseId, eventId)
      .run();
    if (!res.meta.changes) throw new HttpError(404, "Response not found", "responseNotFound");
  } else {
    responseId = crypto.randomUUID();
    editToken = newId(24);
    await db
      .prepare("INSERT INTO responses (id, event_id, name, slots, edit_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(responseId, eventId, name, slots, await sha256(editToken), now, now)
      .run();
  }
  await addVersion(db, eventId, editToken ? "added" : "edited", name, responseId);
  return json({ id: responseId, name, slots, updatedAt: now, editToken }, 200);
}

async function deleteResponse(db, eventId, responseId, input, ip) {
  const event = await loadEvent(db, eventId);
  requireOpen(event);
  await requireEditRight(db, event, responseId, input, ip);
  const row = await db
    .prepare("DELETE FROM responses WHERE id = ? AND event_id = ? RETURNING name")
    .bind(responseId, eventId)
    .first();
  if (!row) throw new HttpError(404, "Response not found", "responseNotFound");
  await addVersion(db, eventId, "removed", row.name, responseId);
  return json({ success: true });
}

async function listVersions(db, eventId) {
  await loadEvent(db, eventId);
  const { results } = await db
    .prepare(
      `SELECT version_number, kind, subject, json_array_length(snapshot) AS people, updated_at FROM versions
       WHERE event_id = ? ORDER BY version_number DESC`,
    )
    .bind(eventId)
    .all();
  return json({
    versions: results.map((v) => ({ number: v.version_number, kind: v.kind, subject: v.subject, people: v.people, at: v.updated_at })),
  });
}

// One version's answers, to preview it in the grid before restoring.
async function getVersion(db, eventId, number) {
  const version = await loadVersion(db, eventId, number);
  const responses = JSON.parse(version.snapshot).map((r) => ({ id: r.id, name: r.name, slots: r.slots, updatedAt: r.updated_at }));
  return json({ number: version.version_number, kind: version.kind, subject: version.subject, at: version.updated_at, responses });
}

// Replaces all answers with the snapshot. Edit tokens come back with them, so people keep their rights.
// Restoring adds a version itself, so it can be undone the same way.
async function restoreVersion(db, eventId, number, { adminPassword }, ip) {
  const event = await loadEvent(db, eventId);
  requireOpen(event);
  await requireAdmin(db, event, adminPassword, ip);
  const version = await loadVersion(db, eventId, number);
  const rows = JSON.parse(version.snapshot);
  await db.batch([
    db.prepare("DELETE FROM responses WHERE event_id = ?").bind(eventId),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO responses (id, event_id, name, slots, edit_token_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.id, eventId, r.name, r.slots, r.edit_token_hash, r.created_at, r.updated_at),
    ),
  ]);
  await addVersion(db, eventId, "restored", String(version.version_number));
  return json({ success: true });
}

// ---------- helpers ----------

async function loadEvent(db, eventId) {
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();
  if (!event) throw new HttpError(404, "Event not found", "eventNotFound");
  return event;
}

async function loadVersion(db, eventId, number) {
  const version = await db
    .prepare("SELECT * FROM versions WHERE event_id = ? AND version_number = ?")
    .bind(eventId, Number(number))
    .first();
  if (!version) throw new HttpError(404, "Version not found", "versionNotFound");
  return version;
}

// Snapshot all answers after a change. An edit right after the same answer's previous save updates
// that version instead of adding one, so a painting session becomes a single version. Keeps the last 100.
async function addVersion(db, eventId, kind, subject = null, responseId = null) {
  const { results } = await db
    .prepare(
      `SELECT id, name, slots, edit_token_hash, created_at, updated_at FROM responses
       WHERE event_id = ? ORDER BY created_at`,
    )
    .bind(eventId)
    .all();
  const snapshot = JSON.stringify(results);
  const now = nowIso();
  if (kind === "edited") {
    const last = await db
      .prepare("SELECT id, kind, response_id, updated_at FROM versions WHERE event_id = ? ORDER BY version_number DESC LIMIT 1")
      .bind(eventId)
      .first();
    if (
      last && last.response_id === responseId && (last.kind === "added" || last.kind === "edited") &&
      Date.parse(now) - Date.parse(last.updated_at) < MERGE_EDITS_MS
    ) {
      await db.batch([
        db.prepare("UPDATE versions SET snapshot = ?, subject = ?, updated_at = ? WHERE id = ?").bind(snapshot, subject, now, last.id),
        db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").bind(now, eventId),
      ]);
      return;
    }
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO versions (id, event_id, version_number, kind, subject, response_id, snapshot, created_at, updated_at)
         SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?, ?, ? FROM versions WHERE event_id = ?`,
      )
      .bind(crypto.randomUUID(), eventId, kind, subject, responseId, snapshot, now, now, eventId),
    db
      .prepare(
        `DELETE FROM versions WHERE event_id = ?
         AND version_number <= (SELECT MAX(version_number) FROM versions WHERE event_id = ?) - ?`,
      )
      .bind(eventId, eventId, MAX_VERSIONS),
    db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").bind(now, eventId),
  ]);
}

// Events without an admin password stay open to anyone with the link. With one, an answer can be
// changed by the browser that created it (edit token) or by the admin.
async function requireEditRight(db, event, responseId, { editToken, adminPassword }, ip) {
  if (!event.admin_password_hash) return;
  const row = await db
    .prepare("SELECT edit_token_hash FROM responses WHERE id = ? AND event_id = ?")
    .bind(responseId, event.id)
    .first();
  if (!row) throw new HttpError(404, "Response not found", "responseNotFound");
  if (!row.edit_token_hash) return; // answered before edit tokens existed
  if (editToken && (await sha256(String(editToken))) === row.edit_token_hash) return;
  if (adminPassword) return requireAdmin(db, event, adminPassword, ip);
  throw new HttpError(403, "Only the person who answered or the admin can change this", "notYours");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64(new Uint8Array(digest));
}

function requireOpen(event) {
  if (event.archived_at) throw new HttpError(409, "This event is archived", "archived");
}

// Wrong tries are counted per event and IP; the masked hint is only sent from the 3rd one on.
async function requireAdmin(db, event, password, ip) {
  if (!event.admin_password_hash) return;
  if (password && (await checkPassword(String(password), event.admin_password_hash))) {
    await db.prepare("DELETE FROM admin_failures WHERE event_id = ? AND ip = ?").bind(event.id, ip).run();
    return;
  }
  const { count } = await db
    .prepare(
      `INSERT INTO admin_failures (event_id, ip, count, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (event_id, ip) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
       RETURNING count`,
    )
    .bind(event.id, ip, nowIso())
    .first();
  const params = count >= HINT_AFTER ? { hint: event.admin_password_hint } : undefined;
  throw new HttpError(403, "Wrong admin password", "wrongPassword", params);
}

// Masked password: first + last character, real length ("p******d").
function passwordHint(password) {
  const chars = [...password];
  if (chars.length <= 3) return "*".repeat(chars.length);
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function checkPassword(password, stored) {
  const [, , saltB64] = stored.split("$");
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const candidate = new TextEncoder().encode(await hashPassword(password, salt));
  const expected = new TextEncoder().encode(stored);
  return candidate.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(candidate, expected);
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function newId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function requireText(value, label, field, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, `${label} is required`, "required", { field });
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long (max ${maxLength})`, "tooLong", { field, max: maxLength });
  return text;
}

async function body(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body", "badRequest");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-app-version": appVersion },
  });
}
