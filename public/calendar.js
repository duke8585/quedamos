// Calendar export helpers (Google Calendar link, .ics file). Plain functions without page state,
// loaded before app.js; test/calendar.test.js loads them through require().

// Next date with ISO weekday `weekday` (1 = Monday), today included, as midnight UTC.
function nextOccurrence(weekday, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const current = new Date(today).getUTCDay() || 7;
  return new Date(today + ((weekday - current + 7) % 7) * 86400000);
}

// 20261030T180000
function calStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15);
}

// Wall-clock time in a time zone (held in UTC fields) to the real instant.
function zonedToUtc(wall, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const offset = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  return wall - offset(wall - offset(wall));
}

function icsEscape(text) {
  return text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

// iCalendar lines are at most 75 bytes; longer ones continue on the next line after a space.
function foldIcsLine(line) {
  const enc = new TextEncoder();
  let out = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > 74) {
      out += "\r\n ";
      size = 1;
    }
    out += ch;
    size += n;
  }
  return out;
}

// One-event .ics file. `from` / `to` are wall-clock times in `timeZone`, written as UTC.
function icsText({ uid, from, to, timeZone, summary, description, url, now = Date.now() }) {
  const utc = (wall) => `${calStamp(zonedToUtc(wall, timeZone))}Z`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Quedamos//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${calStamp(now)}Z`,
    `DTSTART:${utc(from)}`,
    `DTEND:${utc(to)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `URL:${url}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

if (typeof module !== "undefined") module.exports = { nextOccurrence, calStamp, zonedToUtc, icsEscape, foldIcsLine, icsText };
