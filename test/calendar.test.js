import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// public/calendar.js is a plain browser script that also exports through module.exports.
const { nextOccurrence, calStamp, zonedToUtc, icsEscape, foldIcsLine, icsText } = createRequire(import.meta.url)("../public/calendar.js");

const wall = (iso) => Date.parse(`${iso}Z`); // wall-clock time held in UTC fields

describe("nextOccurrence", () => {
  const friday = new Date(2026, 9, 30, 15, 0); // Fri 30 Oct 2026, local time

  it("counts today", () => {
    expect(nextOccurrence(5, friday).toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });

  it("finds later days this week and wraps to next week", () => {
    expect(nextOccurrence(7, friday).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(nextOccurrence(1, friday).toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(nextOccurrence(4, friday).toISOString().slice(0, 10)).toBe("2026-11-05");
  });
});

describe("zonedToUtc", () => {
  it.each([
    ["2026-07-15T18:00:00", "Europe/Berlin", "2026-07-15T16:00:00.000Z"], // summer time, +2
    ["2026-11-02T18:00:00", "Europe/Berlin", "2026-11-02T17:00:00.000Z"], // winter time, +1
    ["2026-03-29T03:30:00", "Europe/Berlin", "2026-03-29T01:30:00.000Z"], // right after the switch
    ["2026-11-02T09:00:00", "America/New_York", "2026-11-02T14:00:00.000Z"],
    ["2026-11-02T09:00:00", "Asia/Kolkata", "2026-11-02T03:30:00.000Z"],
    ["2026-11-02T09:00:00", "UTC", "2026-11-02T09:00:00.000Z"],
  ])("%s in %s is %s", (time, tz, expected) => {
    expect(new Date(zonedToUtc(wall(time), tz)).toISOString()).toBe(expected);
  });
});

describe("ics", () => {
  it("formats stamps", () => {
    expect(calStamp(wall("2026-11-02T18:00:00"))).toBe("20261102T180000");
  });

  it("escapes text values", () => {
    expect(icsEscape("Ana, Ben; C\\D\nnext")).toBe("Ana\\, Ben\\; C\\\\D\\nnext");
  });

  it("folds lines at 75 bytes without splitting characters", () => {
    expect(foldIcsLine("x".repeat(74))).toBe("x".repeat(74));
    const folded = foldIcsLine(`DESCRIPTION:${"ä".repeat(60)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"ä".repeat(60)}`);
  });

  it("builds one event in UTC", () => {
    const text = icsText({
      uid: "abc-1@quedamos",
      from: wall("2026-11-02T18:00:00"),
      to: wall("2026-11-02T20:00:00"),
      timeZone: "Europe/Berlin",
      summary: "Board games, round 2",
      description: "Can make it: Ana, Ben\nhttps://example.com/#/e/abc",
      url: "https://example.com/#/e/abc",
      now: wall("2026-10-30T12:00:00"),
    });
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.split("\r\n")).toEqual(expect.arrayContaining([
      "BEGIN:VEVENT",
      "UID:abc-1@quedamos",
      "DTSTAMP:20261030T120000Z",
      "DTSTART:20261102T170000Z",
      "DTEND:20261102T190000Z",
      "SUMMARY:Board games\\, round 2",
      "DESCRIPTION:Can make it: Ana\\, Ben\\nhttps://example.com/#/e/abc",
      "URL:https://example.com/#/e/abc",
    ]));
  });
});
