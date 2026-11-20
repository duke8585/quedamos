import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// public/gcal.js is a plain browser script that also exports its pure helpers through module.exports.
const { utcToZoned, unionRanges, busyToDayRanges, maxLanes, hashId, freeBusyBodies } = createRequire(import.meta.url)("../public/gcal.js");

const berlin = (days, startMinute = 8 * 60, endMinute = 20 * 60) => ({ days, startMinute, endMinute, slotMinutes: 30, timezone: "Europe/Berlin" });

describe("utcToZoned", () => {
  it("reads the wall clock of the zone, in winter and summer time", () => {
    expect(utcToZoned(Date.parse("2026-11-02T17:00:00Z"), "Europe/Berlin")).toEqual({ date: "2026-11-02", minutes: 18 * 60 });
    expect(utcToZoned(Date.parse("2026-07-15T16:30:00Z"), "Europe/Berlin")).toEqual({ date: "2026-07-15", minutes: 18 * 60 + 30 });
  });

  it("rolls over to the next date after local midnight", () => {
    expect(utcToZoned(Date.parse("2026-11-02T23:30:00Z"), "Europe/Berlin")).toEqual({ date: "2026-11-03", minutes: 30 });
  });
});

describe("unionRanges", () => {
  it("merges overlapping and touching ranges and drops empty ones", () => {
    const out = unionRanges([{ from: 600, to: 660 }, { from: 540, to: 610 }, { from: 660, to: 700 }, { from: 800, to: 800 }, { from: 900, to: 930 }]);
    expect(out).toEqual([{ from: 540, to: 700 }, { from: 900, to: 930 }]);
  });
});

describe("busyToDayRanges", () => {
  it("places a busy block on its day in minutes of the event's zone", () => {
    const ev = berlin(["2026-11-02", "2026-11-03"]);
    const out = busyToDayRanges([{ start: "2026-11-03T09:00:00Z", end: "2026-11-03T10:30:00Z" }], ev);
    expect(out).toEqual([[], [{ from: 10 * 60, to: 11 * 60 + 30 }]]);
  });

  it("clips to the daily window", () => {
    const ev = berlin(["2026-11-02"]);
    const out = busyToDayRanges([{ start: "2026-11-02T05:00:00Z", end: "2026-11-02T08:00:00Z" }, { start: "2026-11-02T18:30:00Z", end: "2026-11-02T22:00:00Z" }], ev);
    expect(out).toEqual([[{ from: 8 * 60, to: 9 * 60 }, { from: 19 * 60 + 30, to: 20 * 60 }]]);
  });

  it("splits an interval that spans midnight over both days", () => {
    const ev = berlin(["2026-11-02", "2026-11-03"], 0, 24 * 60);
    const out = busyToDayRanges([{ start: "2026-11-02T22:00:00Z", end: "2026-11-03T06:00:00Z" }], ev);
    expect(out).toEqual([[{ from: 23 * 60, to: 24 * 60 }], [{ from: 0, to: 7 * 60 }]]);
  });

  it("covers a multi-day interval with the whole window on the days in between", () => {
    const ev = berlin(["2026-11-02", "2026-11-03", "2026-11-04"]);
    const out = busyToDayRanges([{ start: "2026-11-02T15:00:00Z", end: "2026-11-04T10:00:00Z" }], ev);
    expect(out).toEqual([
      [{ from: 16 * 60, to: 20 * 60 }],
      [{ from: 8 * 60, to: 20 * 60 }],
      [{ from: 8 * 60, to: 11 * 60 }],
    ]);
  });

  it("uses the right offset on the day the clocks change", () => {
    // 2026-03-29: Berlin goes from +1 to +2 at 02:00. 05:00Z is 07:00 local afterwards.
    const ev = berlin(["2026-03-28", "2026-03-29"], 0, 24 * 60);
    const out = busyToDayRanges([{ start: "2026-03-28T20:00:00Z", end: "2026-03-29T05:00:00Z" }], ev);
    expect(out).toEqual([[{ from: 21 * 60, to: 24 * 60 }], [{ from: 0, to: 7 * 60 }]]);
  });

  it("merges overlapping busy intervals of one calendar", () => {
    const ev = berlin(["2026-11-02"]);
    const out = busyToDayRanges([{ start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z" }, { start: "2026-11-02T09:30:00Z", end: "2026-11-02T11:00:00Z" }], ev);
    expect(out).toEqual([[{ from: 10 * 60, to: 12 * 60 }]]);
  });

  it("ignores busy time outside every event day", () => {
    const ev = berlin(["2026-11-02"]);
    expect(busyToDayRanges([{ start: "2026-11-05T09:00:00Z", end: "2026-11-05T10:00:00Z" }], ev)).toEqual([[]]);
  });
});

describe("maxLanes", () => {
  it("fits 4 lanes in a 38px phone column", () => {
    expect(maxLanes(38)).toBe(4);
  });

  it("never goes negative on a narrow column", () => {
    expect(maxLanes(10)).toBe(0);
  });
});

describe("hashId", () => {
  it("is the SHA-256 hex of the calendar id", async () => {
    expect(await hashId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("freeBusyBodies", () => {
  it("covers the first window start to the last window end as real instants", () => {
    const [body, ...rest] = freeBusyBodies(berlin(["2026-11-02", "2026-11-04"]), ["a@x", "b@x"]);
    expect(rest).toEqual([]);
    expect(body.timeMin).toBe("2026-11-02T07:00:00.000Z");
    expect(body.timeMax).toBe("2026-11-04T19:00:00.000Z");
    expect(body.items).toEqual([{ id: "a@x" }, { id: "b@x" }]);
  });

  it("splits more than 50 calendars and spans longer than 60 days", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `c${i}`);
    const bodies = freeBusyBodies(berlin(["2026-01-05", "2026-04-05"]), ids);
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.flatMap((b) => b.items.map((i) => i.id))).size).toBe(51);
    expect(Math.max(...bodies.map((b) => b.items.length))).toBe(50);
    expect(Math.max(...bodies.map((b) => Date.parse(b.timeMax) - Date.parse(b.timeMin)))).toBeLessThanOrEqual(60 * 86400000);
  });
});
