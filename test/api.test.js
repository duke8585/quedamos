import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// 2 days x 09:00-11:00 in 30-min slots = 8 slots per answer.
const EVENT = {
  name: "Board games",
  days: ["2026-11-02", "2026-11-03"],
  startMinute: 540,
  endMinute: 660,
  slotMinutes: 30,
  timezone: "Europe/Berlin",
};
const SLOTS = "11110000";
const PASSWORD = "quedamos";

let ipCounter = 0;

async function call(method, path, body, ip = "10.0.0.1") {
  const res = await exports.default.fetch(`https://quedamos.test/api${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function createEvent(extra = {}) {
  const res = await call("POST", "/events", { ...EVENT, ...extra });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function answer(eventId, name, slots = SLOTS) {
  const res = await call("POST", `/events/${eventId}/responses`, { name, slots });
  expect(res.status).toBe(200);
  return res.body; // { id, editToken, ... }
}

const versions = async (eventId) => (await call("GET", `/events/${eventId}/versions`)).body.versions;

describe("events", () => {
  it("creates an event and returns it with its answers", async () => {
    const id = await createEvent();
    await answer(id, "Ana");
    const { status, body } = await call("GET", `/events/${id}`);
    expect(status).toBe(200);
    expect(body.event).toMatchObject({ name: "Board games", slotMinutes: 30, hasAdminPassword: false, archived: false });
    expect(body.responses.map((r) => r.name)).toEqual(["Ana"]);
  });

  it("never returns password or token hashes", async () => {
    const id = await createEvent({ adminPassword: PASSWORD });
    await answer(id, "Ana");
    const { body } = await call("GET", `/events/${id}`);
    expect(JSON.stringify(body)).not.toMatch(/pbkdf2|hash|hint/i);
  });

  it("404s an unknown event", async () => {
    expect((await call("GET", "/events/nope")).body.code).toBe("eventNotFound");
  });

  it.each([
    [{ slotMinutes: 45 }, "badRequest"],
    [{ startMinute: 600, endMinute: 540 }, "badTimes"],
    [{ startMinute: 545 }, "badTimes"],
    [{ slotMinutes: 90, startMinute: 600, endMinute: 1260 }, "slotFit"],
    [{ days: [] }, "noDays"],
    [{ name: " " }, "required"],
  ])("rejects %o with %s", async (extra, code) => {
    const res = await call("POST", "/events", { ...EVENT, ...extra });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  it.each([90, 120, 180])("accepts %i-minute slots when the window fits", async (slotMinutes) => {
    const res = await call("POST", "/events", { ...EVENT, slotMinutes, startMinute: 540, endMinute: 1260 });
    expect(res.status).toBe(201);
  });

  it("looks up names and flags for the recent list", async () => {
    const open = await createEvent();
    const locked = await createEvent({ adminPassword: PASSWORD });
    const { body } = await call("GET", `/events?ids=${open},${locked},missing`);
    expect(body.events).toHaveLength(2);
    expect(body.events.find((e) => e.id === locked).hasAdminPassword).toBe(true);
  });
});

describe("answers", () => {
  it("rejects slots of the wrong length or with unknown values", async () => {
    const id = await createEvent();
    for (const slots of ["111", "11113333"]) {
      const res = await call("POST", `/events/${id}/responses`, { name: "Ana", slots });
      expect(res.body.code).toBe("badRequest");
    }
  });

  it("refuses a second answer under a taken name, case-insensitive", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    const res = await call("POST", `/events/${id}/responses`, { name: "ana", slots: SLOTS });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "nameTaken", params: { id: ana.id } });
  });

  it("lets anyone change answers on an event without a password", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    const res = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "22220000" });
    expect(res.status).toBe(200);
    expect((await call("DELETE", `/events/${id}/responses/${ana.id}`, {})).status).toBe(200);
  });
});

describe("rights on a protected event", () => {
  async function setup() {
    const id = await createEvent({ adminPassword: PASSWORD });
    return { id, ana: await answer(id, "Ana") };
  }

  it("lets the answer's own edit token change it", async () => {
    const { id, ana } = await setup();
    const res = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "22220000", editToken: ana.editToken });
    expect(res.status).toBe(200);
  });

  it("refuses someone else's token, a missing one and a wrong password", async () => {
    const { id, ana } = await setup();
    const ben = await answer(id, "Ben");
    for (const auth of [{ editToken: ben.editToken }, {}, { adminPassword: "nope" }]) {
      const res = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: SLOTS, ...auth });
      expect(res.status).toBe(403);
    }
    expect((await call("DELETE", `/events/${id}/responses/${ana.id}`, { editToken: ben.editToken })).body.code).toBe("notYours");
  });

  it("lets the admin change and remove anyone", async () => {
    const { id, ana } = await setup();
    const put = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "22220000", adminPassword: PASSWORD });
    expect(put.status).toBe(200);
    expect((await call("DELETE", `/events/${id}/responses/${ana.id}`, { adminPassword: PASSWORD })).status).toBe(200);
  });

  it("checks the admin password via verify", async () => {
    const { id } = await setup();
    expect((await call("POST", `/events/${id}/verify`, { adminPassword: PASSWORD })).status).toBe(200);
    expect((await call("POST", `/events/${id}/verify`, { adminPassword: "nope" })).status).toBe(403);
  });
});

describe("password hint", () => {
  it("shows the masked password from the 3rd wrong try on, per IP, and resets after a right one", async () => {
    const id = await createEvent({ adminPassword: PASSWORD });
    const ip = `10.1.0.${++ipCounter}`;
    const tryPassword = (adminPassword, from = ip) => call("POST", `/events/${id}/verify`, { adminPassword }, from);

    expect((await tryPassword("a")).body.params).toBeUndefined();
    expect((await tryPassword("b")).body.params).toBeUndefined();
    expect((await tryPassword("c")).body.params).toEqual({ hint: "q******s" });
    expect((await tryPassword("d", "10.2.0.1")).body.params).toBeUndefined();

    await tryPassword(PASSWORD);
    expect((await tryPassword("e")).body.params).toBeUndefined();
  });

  it("masks short passwords completely", async () => {
    const id = await createEvent({ adminPassword: "abc" });
    const ip = `10.3.0.${++ipCounter}`;
    let res;
    for (let i = 0; i < 3; i++) res = await call("POST", `/events/${id}/verify`, { adminPassword: "x" }, ip);
    expect(res.body.params).toEqual({ hint: "***" });
  });
});

describe("archive", () => {
  it("needs the password and blocks all writes until unarchived", async () => {
    const id = await createEvent({ adminPassword: PASSWORD });
    const ana = await answer(id, "Ana");
    expect((await call("POST", `/events/${id}/archive`, { adminPassword: "nope", archived: true })).status).toBe(403);
    expect((await call("POST", `/events/${id}/archive`, { adminPassword: PASSWORD, archived: true })).status).toBe(200);

    const writes = [
      call("POST", `/events/${id}/responses`, { name: "Ben", slots: SLOTS }),
      call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: SLOTS, editToken: ana.editToken }),
      call("DELETE", `/events/${id}/responses/${ana.id}`, { adminPassword: PASSWORD }),
      call("POST", `/events/${id}/versions/1/restore`, { adminPassword: PASSWORD }),
    ];
    for (const res of await Promise.all(writes)) expect(res.body.code).toBe("archived");

    await call("POST", `/events/${id}/archive`, { adminPassword: PASSWORD, archived: false });
    expect((await call("POST", `/events/${id}/responses`, { name: "Ben", slots: SLOTS })).status).toBe(200);
  });

  it("is only possible with an admin password", async () => {
    const id = await createEvent();
    expect((await call("POST", `/events/${id}/archive`, { archived: true })).body.code).toBe("noPassword");
  });
});

describe("versions", () => {
  it("records create, add, edit and remove", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    await answer(id, "Ben");
    await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "22220000" });
    await call("DELETE", `/events/${id}/responses/${ana.id}`, {});
    const list = await versions(id);
    expect(list.map((v) => [v.number, v.kind, v.subject, v.people])).toEqual([
      [5, "removed", "Ana", 1],
      [4, "edited", "Ana", 2],
      [3, "added", "Ben", 2],
      [2, "added", "Ana", 1],
      [1, "created", null, 0],
    ]);
  });

  it("merges a painting session of one person into one version", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    for (const slots of ["10000000", "11000000", "11100000"]) {
      await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots });
    }
    let list = await versions(id);
    expect(list.map((v) => v.kind)).toEqual(["added", "created"]);
    expect((await call("GET", `/events/${id}/versions/2`)).body.responses[0].slots).toBe("11100000");

    // someone else in between starts a new version
    const ben = await answer(id, "Ben");
    await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "11110000" });
    await call("PUT", `/events/${id}/responses/${ben.id}`, { name: "Ben", slots: "00001111" });
    list = await versions(id);
    expect(list.map((v) => `${v.kind}:${v.subject ?? ""}`)).toEqual(["edited:Ben", "edited:Ana", "added:Ben", "added:Ana", "created:"]);
  });

  it("starts a new version once the last one is older than 15 minutes", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    await env.DB.prepare("UPDATE versions SET updated_at = ? WHERE event_id = ?").bind(old, id).run();
    await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: "00000000" });
    expect((await versions(id)).map((v) => v.kind)).toEqual(["edited", "added", "created"]);
  });

  it("keeps the last 100", async () => {
    const id = await createEvent();
    const ana = await answer(id, "Ana");
    const ben = await answer(id, "Ben");
    for (let i = 0; i < 100; i++) {
      const who = i % 2 ? ben : ana; // alternating people, so nothing merges
      await call("PUT", `/events/${id}/responses/${who.id}`, { name: i % 2 ? "Ben" : "Ana", slots: String(i % 3).repeat(8) });
    }
    const list = await versions(id);
    expect(list).toHaveLength(100);
    expect(list[0].number).toBe(103);
    expect(list.at(-1).number).toBe(4);
    expect((await call("GET", `/events/${id}/versions/3`)).body.code).toBe("versionNotFound");
  });

  it("does not leak edit token hashes in a version", async () => {
    const id = await createEvent();
    await answer(id, "Ana");
    const { body } = await call("GET", `/events/${id}/versions/2`);
    expect(Object.keys(body.responses[0]).sort()).toEqual(["id", "name", "slots", "updatedAt"]);
  });

  it("restores an older version, adds a version for it, and old edit tokens keep working", async () => {
    const id = await createEvent({ adminPassword: PASSWORD });
    const ana = await answer(id, "Ana", "11110000");
    const ben = await answer(id, "Ben");
    await call("DELETE", `/events/${id}/responses/${ana.id}`, { adminPassword: PASSWORD });

    expect((await call("POST", `/events/${id}/versions/3/restore`, { adminPassword: "nope" })).status).toBe(403);
    expect((await call("POST", `/events/${id}/versions/3/restore`, { adminPassword: PASSWORD })).status).toBe(200);

    const { body } = await call("GET", `/events/${id}`);
    expect(body.responses.map((r) => [r.name, r.slots])).toEqual([["Ana", "11110000"], ["Ben", SLOTS]]);
    expect((await versions(id))[0]).toMatchObject({ number: 5, kind: "restored", subject: "3" });

    const put = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: SLOTS, editToken: ana.editToken });
    expect(put.status).toBe(200);
    const wrong = await call("PUT", `/events/${id}/responses/${ana.id}`, { name: "Ana", slots: SLOTS, editToken: ben.editToken });
    expect(wrong.status).toBe(403);
  });

  it("lets anyone restore on an event without a password", async () => {
    const id = await createEvent();
    await answer(id, "Ana");
    expect((await call("POST", `/events/${id}/versions/1/restore`, {})).status).toBe(200);
    expect((await call("GET", `/events/${id}`)).body.responses).toEqual([]);
  });
});
