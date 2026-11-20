// Google Calendar busy times as a shadow behind your own painting. Everything happens in this
// browser: the access token, the calendar list and the busy times live in memory only, and nothing
// is sent to the Quedamos server. Free/busy only, never event titles.
// The first half is plain functions (tests load them through require()); the second half is the
// browser-only controller and is loaded before app.js, using its helpers (h, t, getStored) at call time.

const tzToUtc = typeof module !== "undefined" ? require("./calendar.js").zonedToUtc : zonedToUtc;

const DAY_MS = 86400000;
const FREEBUSY_MAX_CALENDARS = 50;
const FREEBUSY_MAX_SPAN_DAYS = 60;
const LANE_WIDTH = 4; // 3px lane + 1px gap
const LANE_MARGIN = 20; // room left for the hatch next to the lanes

// ---------- pure helpers ----------

const zonedFormats = new Map();

// The wall-clock time an instant has in a time zone: { date: "2026-03-29", minutes: 150.5 }.
function utcToZoned(ms, timeZone) {
  let fmt = zonedFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    zonedFormats.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute + p.second / 60 };
}

// Merge overlapping or touching { from, to } ranges into a sorted list.
function unionRanges(ranges) {
  const sorted = ranges.filter((r) => r.to > r.from).map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

// Busy intervals ({ start, end }, ISO strings or ms) to minute ranges per event day, in the event's
// time zone, clipped to the daily window [startMinute, endMinute]. Index = day index of event.days.
function busyToDayRanges(busyIntervals, event) {
  const spans = busyIntervals.map((b) => ({ a: new Date(b.start).getTime(), b: new Date(b.end).getTime() })).filter((s) => s.b > s.a);
  return event.days.map((day) => {
    const [y, m, d] = day.split("-").map(Number);
    const winStart = tzToUtc(Date.UTC(y, m - 1, d, 0, event.startMinute), event.timezone);
    const winEnd = tzToUtc(Date.UTC(y, m - 1, d, 0, event.endMinute), event.timezone);
    const ranges = [];
    for (const s of spans) {
      const a = Math.max(s.a, winStart);
      const b = Math.min(s.b, winEnd);
      if (b <= a) continue;
      // the window edges are exact; only instants inside the window need the zone lookup
      ranges.push({
        from: a === winStart ? event.startMinute : utcToZoned(a, event.timezone).minutes,
        to: b === winEnd ? event.endMinute : utcToZoned(b, event.timezone).minutes,
      });
    }
    return unionRanges(ranges);
  });
}

// How many calendar lanes fit in a day column of this width; more calendars than that show the hatch only.
function maxLanes(colWidthPx) {
  return Math.max(0, Math.floor((colWidthPx - LANE_MARGIN) / LANE_WIDTH));
}

async function hashId(id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// FreeBusy request bodies covering all event days: the calendars in chunks of 50, the time span in chunks of 60 days.
function freeBusyBodies(event, ids) {
  const wall = (day, minute) => {
    const [y, m, d] = day.split("-").map(Number);
    return tzToUtc(Date.UTC(y, m - 1, d, 0, minute), event.timezone);
  };
  const days = [...event.days].sort();
  const min = wall(days[0], event.startMinute);
  const max = wall(days.at(-1), event.endMinute);
  const bodies = [];
  for (let from = min; from < max; from += FREEBUSY_MAX_SPAN_DAYS * DAY_MS) {
    const to = Math.min(max, from + FREEBUSY_MAX_SPAN_DAYS * DAY_MS);
    for (let i = 0; i < ids.length; i += FREEBUSY_MAX_CALENDARS) {
      bodies.push({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        timeZone: event.timezone,
        items: ids.slice(i, i + FREEBUSY_MAX_CALENDARS).map((id) => ({ id })),
      });
    }
  }
  return bodies;
}

if (typeof module !== "undefined") module.exports = { utcToZoned, unionRanges, busyToDayRanges, maxLanes, hashId, freeBusyBodies };

// ---------- controller (browser only) ----------

const GCAL_CLIENT_ID = "259483534472-v58b37iggpefl86qlpq1b7n1p2bud4ik.apps.googleusercontent.com";
const GCAL_SCOPES = ["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const GCAL_STORE_KEY = "quedamos.gcal"; // JSON array of SHA-256 hex hashes of the picked calendar ids
const GCAL_API = "https://www.googleapis.com/calendar/v3";

const GCAL_ERROR_KINDS = {
  popup_closed: "popup", popup_failed_to_open: "popup", access_denied: "denied",
  admin_policy_required: "blocked", org_internal: "blocked", scope: "scope", expired: "expired",
};

// `code` is the kind of failure the panel has a message for (gcalErr_<code>); anything unknown is "network".
class GcalError extends Error {
  constructor(raw) {
    super(raw);
    this.code = GCAL_ERROR_KINDS[raw] ?? "network";
  }
}

// status: off -> notice -> connecting -> picking -> on; error from anywhere. Nothing else is kept between page loads.
const gcal = {
  status: "off", // "off" | "notice" | "connecting" | "picking" | "on" | "error"
  error: null, // GcalError code while status is "error"
  calendars: [], // { id, name, color, on, picked }: picked = chosen in the picker, on = shown (legend toggle)
  busy: new Map(), // calendarId -> per day index: [{ from, to }] minutes
  dataKey: null, // the event the busy times were loaded for
  loading: false,
  loadId: 0, // bumped to drop the result of a load that is no longer wanted
  token: null,
  tokenExp: 0,
  accepted: false, // the privacy notice was confirmed in this page load
  run: 0, // bumped on disconnect so a request still in flight can't revive a disconnected layer
  view: null, // { grid, event, rowH, show } of the last renderBusy
  panel: null,
  script: null,
};

function gcalSetStatus(status, error = null) {
  gcal.status = status;
  gcal.error = error;
  gcalRefresh();
}

function gcalRefresh() {
  gcalRenderPanel();
  gcalRenderBusy();
}

function gcalLoadScript() {
  gcal.script ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://accounts.google.com/gsi/client";
    el.onload = resolve;
    el.onerror = () => {
      gcal.script = null;
      reject(new GcalError("network"));
    };
    document.head.append(el);
  });
  return gcal.script;
}

function gcalRequestToken(prompt) {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GCAL_CLIENT_ID,
      scope: GCAL_SCOPES.join(" "),
      callback: (res) => {
        if (res.error) return reject(new GcalError(res.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(res, ...GCAL_SCOPES)) return reject(new GcalError("scope"));
        gcal.token = res.access_token;
        gcal.tokenExp = Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60000;
        resolve();
      },
      error_callback: (err) => reject(new GcalError(err.type || "popup_closed")),
    });
    client.requestAccessToken({ prompt });
  });
}

// Authorized request; one silent token refresh on expiry or a 401, then the user has to reconnect.
async function gcalFetch(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!gcal.token || Date.now() > gcal.tokenExp) {
      await gcalRequestToken("").catch(() => {
        throw new GcalError("expired");
      });
    }
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${gcal.token}` } });
    } catch {
      throw new GcalError("network");
    }
    if (res.status === 401) {
      gcal.token = null;
      continue;
    }
    if (!res.ok) throw new GcalError(res.status === 403 ? "access_denied" : "network");
    return res.json();
  }
  throw new GcalError("expired");
}

async function gcalListCalendars() {
  const items = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ maxResults: "250", fields: "nextPageToken,items(id,summary,summaryOverride,backgroundColor,selected,primary)" });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await gcalFetch(`${GCAL_API}/users/me/calendarList?${q}`);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  let stored = [];
  try {
    stored = JSON.parse(getStored(GCAL_STORE_KEY) || "[]");
  } catch {
    stored = [];
  }
  const hashes = await Promise.all(items.map((c) => hashId(c.id)));
  let picked = items.map((_, i) => stored.includes(hashes[i]));
  if (!picked.some(Boolean)) picked = items.map((c) => !!(c.selected || c.primary));
  return items.map((c, i) => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor || "") ? c.backgroundColor : "#78716c",
    picked: picked[i],
    on: picked[i],
  }));
}

function gcalEventKey(event) {
  return [event.id, event.timezone, event.startMinute, event.endMinute, event.days.join()].join("|");
}

// FreeBusy for the picked calendars over the event's days. A calendar Google reports errors for is marked failed.
async function gcalLoadBusy(event) {
  const load = ++gcal.loadId;
  const key = gcalEventKey(event);
  const ids = gcal.calendars.filter((c) => c.picked).map((c) => c.id);
  gcal.loading = true;
  gcal.busy = new Map();
  gcal.dataKey = key;
  try {
    const intervals = new Map(ids.map((id) => [id, []]));
    const failed = new Set();
    for (const body of freeBusyBodies(event, ids)) {
      const data = await gcalFetch(`${GCAL_API}/freeBusy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      for (const id of ids) {
        const cal = data.calendars?.[id];
        if (!cal || cal.errors?.length) failed.add(id);
        else intervals.get(id).push(...(cal.busy || []));
      }
    }
    if (gcal.loadId !== load) return;
    for (const c of gcal.calendars) c.failed = failed.has(c.id);
    for (const id of ids) if (!failed.has(id)) gcal.busy.set(id, busyToDayRanges(intervals.get(id), event));
    gcal.loading = false;
    gcalRefresh();
  } catch (err) {
    if (gcal.loadId !== load) return;
    gcal.loading = false;
    gcal.dataKey = null;
    gcalFail(err);
  }
}

// ---------- dialogs ----------

// Same look as the password dialog in index.html. Resolves true on the confirm button.
function gcalDialog({ title, body, confirm }) {
  let dialog = document.getElementById("gcal-modal");
  if (!dialog) {
    dialog = h("dialog", { id: "gcal-modal", class: "m-auto w-[min(26rem,calc(100%-2rem))] rounded-3xl p-0 shadow-2xl backdrop:bg-stone-900/50 backdrop:backdrop-blur-sm" });
    document.body.append(dialog);
  }
  fill(dialog, h("form", { method: "dialog", class: "flex flex-col gap-4 p-6" },
    h("h3", { class: "text-xl font-bold" }, title),
    body,
    h("div", { class: "flex justify-end gap-3" },
      h("button", { type: "button", class: "btn", onclick: () => dialog.close("") }, t("cancel")),
      h("button", { value: "ok", class: "btn btn-primary" }, confirm)),
  ));
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.returnValue = "";
    dialog.showModal();
  });
}

function gcalNotice() {
  return gcalDialog({
    title: t("gcalNoticeTitle"),
    confirm: t("gcalContinue"),
    body: h("div", { class: "flex flex-col gap-2 text-stone-600" },
      h("ul", { class: "list-disc space-y-1 pl-5" }, ["gcalNotice1", "gcalNotice2", "gcalNotice3", "gcalNotice4"].map((k) => h("li", null, t(k)))),
      h("a", { href: "/privacy", target: "_blank", class: "underline hover:text-stone-900" }, t("privacy"))),
  });
}

async function gcalPicker() {
  const boxes = gcal.calendars.map((c) => ({
    c,
    input: h("input", { type: "checkbox", class: "size-4 accent-emerald-600", checked: c.picked }),
  }));
  const ok = await gcalDialog({
    title: t("gcalPickTitle"),
    confirm: t("gcalApply"),
    body: h("div", { class: "flex flex-col gap-3" },
      h("ul", { class: "flex max-h-72 flex-col gap-1 overflow-y-auto" }, boxes.map(({ c, input }) =>
        h("li", null, h("label", { class: "flex cursor-pointer items-center gap-2.5 rounded-xl px-1 py-1.5 hover:bg-stone-50" },
          input, h("span", { class: "size-3 flex-none rounded-full", style: `background:${c.color}` }), h("span", { class: "min-w-0 truncate" }, c.name))))),
      h("p", { class: "text-sm text-stone-500" }, t("gcalSharedNote"))),
  });
  if (ok) for (const { c, input } of boxes) c.on = c.picked = input.checked;
  return ok;
}

// ---------- actions ----------

function gcalFail(err) {
  gcalSetStatus("error", err instanceof GcalError ? err.code : "network");
}

async function gcalConnect() {
  if (!["off", "error"].includes(gcal.status)) return;
  const run = ++gcal.run;
  if (!gcal.accepted) {
    gcalSetStatus("notice");
    if (!(await gcalNotice())) return gcalSetStatus("off");
    gcal.accepted = true;
  }
  gcalSetStatus("connecting");
  try {
    await gcalLoadScript();
    await gcalRequestToken("");
    gcal.calendars = await gcalListCalendars();
    if (gcal.run !== run) return;
    gcalSetStatus("picking");
    const ok = await gcalPicker();
    if (gcal.run !== run) return;
    if (!ok) return gcalSetStatus("off");
    await gcalApply();
  } catch (err) {
    if (gcal.run === run) gcalFail(err);
  }
}

function gcalSaveSelection() {
  Promise.all(gcal.calendars.filter((c) => c.picked).map((c) => hashId(c.id))).then((hashes) => setStored(GCAL_STORE_KEY, JSON.stringify(hashes)));
}

async function gcalApply() {
  gcalSaveSelection();
  gcal.dataKey = null;
  gcal.loading = false;
  gcal.loadId++;
  gcalSetStatus("on");
}

// The picker again, from the panel.
async function gcalEditSelection() {
  const run = gcal.run;
  const ok = await gcalPicker();
  if (ok && gcal.run === run) await gcalApply();
}

// After an expired token: ask Google again (this click is the user gesture), keep the calendar choice.
async function gcalReconnect() {
  const run = gcal.run;
  gcalSetStatus("connecting");
  try {
    await gcalRequestToken("");
    await gcalApply();
  } catch (err) {
    if (gcal.run === run) gcalFail(err);
  }
}

function gcalDisconnect() {
  const token = gcal.token;
  gcal.run++;
  gcal.loadId++;
  if (token && typeof google !== "undefined") google.accounts.oauth2.revoke(token, () => {});
  Object.assign(gcal, { token: null, tokenExp: 0, calendars: [], busy: new Map(), dataKey: null, loading: false });
  setStored(GCAL_STORE_KEY, null);
  gcalSetStatus("off");
}

function gcalToggle(calendar) {
  calendar.on = !calendar.on;
  gcalRefresh();
}

// ---------- rendering ----------

// Draw the shadow into each day column of `grid`, or remove it. Reads the controller state only;
// called with a view after the grid was (re)built, without one after a toggle.
function gcalRenderBusy(view) {
  if (view) gcal.view = view;
  const v = gcal.view;
  if (!v?.grid?.isConnected) return;
  const show = v.show && gcal.status === "on";
  if (show && !gcal.loading && gcal.dataKey !== gcalEventKey(v.event)) gcalLoadBusy(v.event);
  const enabled = gcal.calendars.filter((c) => c.picked && c.on && gcal.busy.has(c.id));
  const pxPerMinute = v.rowH / v.event.slotMinutes;
  const px = (min) => ((min - v.event.startMinute) * pxPerMinute).toFixed(1);
  const box = (r, style, cls) => h("div", { class: cls, style: `top:${px(r.from)}px;height:${Math.max(2, (r.to - r.from) * pxPerMinute).toFixed(1)}px;${style}` });
  for (const col of v.grid.querySelectorAll(".ag-col")) {
    col.querySelector(":scope > .busy-layer")?.remove();
    if (!show || !enabled.length) continue;
    const d = Number(col.dataset.d);
    const lanes = enabled.length <= maxLanes(col.clientWidth);
    const layer = h("div", { class: "busy-layer", "aria-hidden": "true" },
      unionRanges(enabled.flatMap((c) => gcal.busy.get(c.id)[d])).map((r) => box(r, "", "busy-block")),
      lanes && enabled.map((c, k) => gcal.busy.get(c.id)[d].map((r) => box(r, `left:${1 + LANE_WIDTH * k}px;background:${c.color}`, "busy-lane"))),
    );
    col.prepend(layer);
  }
}

// The panel section: connect button, errors, legend chips with the hatch swatch, picker and disconnect.
function gcalSection() {
  gcal.panel = h("div", { class: "flex flex-col gap-2 border-t border-stone-200 pt-4" });
  gcalRenderPanel();
  return gcal.panel;
}

function gcalRenderPanel() {
  if (!gcal.panel) return;
  const small = "btn btn-sm";
  const title = h("span", { class: "text-sm font-semibold text-stone-700" }, t("gcalTitle"));
  if (gcal.status === "off" || gcal.status === "error") {
    const expired = gcal.status === "error" && gcal.error === "expired";
    fill(gcal.panel, title,
      gcal.status === "error" && h("p", { class: "text-sm font-medium text-rose-700" }, t(`gcalErr_${gcal.error}`)),
      h("div", { class: "flex flex-wrap items-center gap-2" },
        h("button", { type: "button", class: small, onclick: expired ? gcalReconnect : gcalConnect }, expired ? t("gcalReconnect") : t("gcalConnect"))),
      gcal.status === "off" && h("p", { class: "text-sm text-stone-500" }, t("gcalHint")));
  } else if (gcal.status === "on") {
    fill(gcal.panel, title,
      h("div", { class: "flex flex-wrap items-center gap-1.5" },
        gcal.calendars.filter((c) => c.picked).map((c) =>
          h("button", {
            type: "button",
            "aria-pressed": String(c.on && !c.failed),
            disabled: c.failed,
            title: c.failed ? t("gcalUnavailable") : null,
            class: "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-sm font-medium ring-1 ring-stone-300 hover:bg-stone-100 disabled:cursor-default disabled:opacity-50 aria-[pressed=false]:opacity-50 aria-[pressed=false]:line-through",
            onclick: () => gcalToggle(c),
          }, h("span", { class: "size-3 flex-none rounded-full", style: `background:${c.color}` }), h("span", { class: "truncate" }, c.name))),
        h("span", { class: "ml-1 inline-flex items-center gap-1.5 text-sm text-stone-500" }, h("span", { class: "busy-swatch" }), t("gcalBusy"))),
      gcal.calendars.filter((c) => c.picked && c.on).length > maxLanes(gcalColumnWidth()) && h("p", { class: "text-sm text-stone-500" }, t("gcalTooMany")),
      h("div", { class: "flex flex-wrap gap-2" },
        h("button", { type: "button", class: small, onclick: gcalEditSelection }, t("gcalCalendars")),
        h("button", { type: "button", class: small, onclick: gcalDisconnect }, t("gcalDisconnect"))));
  } else {
    fill(gcal.panel, title, h("p", { class: "text-sm text-stone-500" }, t("gcalConnecting")));
  }
}

function gcalColumnWidth() {
  return gcal.view?.grid?.querySelector(".ag-col")?.clientWidth || 0;
}
