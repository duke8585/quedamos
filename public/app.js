"use strict";

// ---------- state ----------

const ROW_HEIGHT = { 15: 13, 30: 20, 60: 32, 90: 44, 120: 52, 180: 68 }; // px per slot row
const RECENT_MAX = 12;

const state = {
  eventId: null,
  data: null, // GET /events/:id response
  self: null, // my own answer in the editor (see newAnswer); its id is remembered per event in localStorage
  edit: null, // the answer being painted: state.self, or someone this browser added (any answer as admin)
  ghost: getStored("quedamos.ghost") !== "0", // show when others are free behind the editor
  mode: "group", // "group" | "edit"
  brush: 1, // 1 = available, 2 = if needed
  page: 0,
  focus: null, // response id shown alone in the grid (group mode)
  sel: null, // selected slot index (group mode)
  selRange: null, // { start, len } around sel: a best time, or the slots where the same people are free
  exportOpen: false, // calendar buttons shown for the pinned slot
  selPinned: false, // sel was clicked/tapped (stays) rather than hovered
  confirmDelete: false,
  confirmRemove: null, // response id waiting for a second click on "remove" (admin)
  admin: new Map(), // eventId -> admin password, kept in memory for this page load only
  showArchived: false,
  showHistory: false,
  versions: null, // version history, loaded when opened
  preview: null, // a past version shown instead of the current answers: { number, at, responses }
  appVersion: null,
  form: null, // create-event form
};

// DOM references for partial updates (rebuilt on every full render)
const ui = { grid: null, cells: new Map(), panel: null, status: null, info: null, sheet: null };

const app = document.getElementById("app");

function applyStaticTexts() {
  document.documentElement.lang = lang;
  const set = (id, text) => (document.getElementById(id).textContent = text);
  set("brand-name", t("appName"));
  set("update-text", t("updateAvailable"));
  set("update-reload", t("reload"));

  const sw = document.getElementById("lang-switch");
  sw.setAttribute("aria-label", t("language"));
  sw.replaceChildren(
    ...LANGS.map((code) =>
      h("button", {
        type: "button",
        lang: code,
        "aria-pressed": String(code === lang),
        class: code === lang
          ? "min-h-8 min-w-10 cursor-pointer rounded-full bg-white px-2.5 text-sm font-bold text-stone-900 shadow-sm"
          : "min-h-8 min-w-10 cursor-pointer rounded-full px-2.5 text-sm font-semibold text-stone-500 hover:text-stone-900",
        onclick: () => {
          if (code === lang) return;
          setLang(code);
          applyStaticTexts();
          if (state.eventId && state.data) renderEvent();
          else if (!state.eventId) renderHome();
        },
      }, code.toUpperCase()),
    ),
  );
}
applyStaticTexts();

// ---------- helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// replaceChildren that skips null/false like h() does, so `cond && h(...)` works
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  checkVersion(res.headers.get("x-app-version"));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.code && STRINGS.en[`err_${data.code}`] ? t(`err_${data.code}`, data.params || {}) : data.error;
    const err = new Error(message || t("requestFailed", res.status));
    err.status = res.status;
    err.code = data.code;
    err.params = data.params;
    throw err;
  }
  return data;
}

// A tab opened before a deploy keeps running old code (hash routing never reloads), so offer a reload.
function checkVersion(version) {
  if (!version) return;
  if (!state.appVersion) state.appVersion = version;
  else if (version !== state.appVersion) document.getElementById("update-banner").hidden = false;
}

function getStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStored(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable, ignore */
  }
}

// Edit tokens of the answers this browser created, per event: { responseId: token }.
function tokens(eventId) {
  try {
    return JSON.parse(getStored(`quedamos.tokens.${eventId}`)) || {};
  } catch {
    return {};
  }
}

function tokenFor(eventId, responseId) {
  if (!responseId) return undefined;
  const token = tokens(eventId)[responseId];
  if (token) return token;
  // before tokens were kept per answer, there was only the one for my own answer
  if (responseId === getStored(`quedamos.me.${eventId}`)) return getStored(`quedamos.token.${eventId}`) || undefined;
  return undefined;
}

function setToken(eventId, responseId, token) {
  const all = tokens(eventId);
  if (token) all[responseId] = token;
  else delete all[responseId];
  setStored(`quedamos.tokens.${eventId}`, JSON.stringify(all));
}

function recentEvents() {
  try {
    const list = JSON.parse(getStored("quedamos.recent") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberEvent(event) {
  const list = recentEvents().filter((e) => e.id !== event.id);
  list.unshift({ id: event.id, name: event.name, hasAdminPassword: event.hasAdminPassword, archived: event.archived });
  setStored("quedamos.recent", JSON.stringify(list.slice(0, RECENT_MAX)));
}

// Refresh names / password / archived flags of the remembered events; drops events that no longer exist.
async function refreshRecent() {
  const list = recentEvents();
  if (!list.length) return false;
  const { events } = await api("GET", `/events?ids=${list.map((e) => e.id).join(",")}`);
  const byId = new Map(events.map((e) => [e.id, e]));
  const next = list.filter((e) => byId.has(e.id)).map((e) => byId.get(e.id));
  const changed = JSON.stringify(next) !== JSON.stringify(list);
  if (changed) setStored("quedamos.recent", JSON.stringify(next));
  return changed;
}

function lockIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "size-3.5");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"/>';
  return svg;
}

// Shown on events with an admin password: a lock, plus the masked password ("q******s") once this
// browser has had it revealed after 3 wrong tries.
function lockBadge(eventId) {
  const hint = getStored(`quedamos.hint.${eventId}`);
  return h("span", { class: "badge bg-stone-100 text-stone-600 ring-1 ring-stone-200", title: t("protectedTitle") },
    lockIcon(), hint ? h("span", { class: "font-mono" }, hint) : t("protected"));
}

// Password modal. `verify(pw)` should throw on a wrong password; the modal stays open and shows the error.
function askPassword({ title, text, verify }) {
  document.getElementById("modal-user").value = state.eventId || "";
  const dialog = document.getElementById("modal");
  const form = dialog.querySelector("form");
  const input = document.getElementById("modal-input");
  const error = document.getElementById("modal-error");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-text").textContent = text;
  document.getElementById("modal-cancel").textContent = t("cancel");
  document.getElementById("modal-ok").textContent = t("ok");
  input.value = "";
  error.hidden = true;

  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      e.preventDefault();
      const pw = input.value;
      if (!pw) return;
      try {
        if (verify) await verify(pw);
        cleanup();
        dialog.close();
        resolve(pw);
      } catch (err) {
        // The server only sends the masked hint (first + last character) from the 3rd wrong try on.
        const hint = err.params?.hint;
        error.textContent = hint ? `${err.message}. ${t("pwHint", hint)}` : err.message;
        error.hidden = false;
        input.select();
      }
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("close", onClose);
    };
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    input.focus();
  });
}
document.getElementById("modal-cancel").addEventListener("click", () => document.getElementById("modal").close());

// Ask for the open event's admin password; `action(pw)` runs the protected request and throws on a
// wrong password. The server counts wrong tries and sends the masked hint from the 3rd one on,
// which this browser then remembers for the badge. Returns the password, or null if cancelled.
async function askAdmin(text, action) {
  const eventId = state.eventId;
  const pw = await askPassword({
    title: t("adminPassword"),
    text,
    verify: (p) =>
      action(p).catch((err) => {
        if (err.params?.hint) setStored(`quedamos.hint.${eventId}`, err.params.hint);
        throw err;
      }),
  });
  if (pw) state.admin.set(eventId, pw);
  return pw;
}

// Unlock admin mode for the open event (per event, for this page load).
function unlockAdmin() {
  const eventId = state.eventId;
  return askAdmin(t("adminText"), (p) => api("POST", `/events/${eventId}/verify`, { adminPassword: p }));
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function showError(err) {
  console.error(err);
  toast(err.message || String(err));
}

function hue(text) {
  let x = 0;
  for (const c of text.toLowerCase()) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
}

function avatar(name) {
  return h("span", { class: "avatar", style: `--h:${hue(name)}`, "aria-hidden": "true" }, initials(name));
}

function fmtMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// 2024-01-01 was a Monday, so day n of January 2024 is ISO weekday n.
function weekdayDate(n) {
  return new Date(Date.UTC(2024, 0, n));
}

function fmtWeekday(date, style = "short") {
  return date.toLocaleDateString(locale(), { weekday: style, timeZone: "UTC" });
}

function fmtDayMonth(date) {
  return date.toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function myTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ---------- routing ----------

function route() {
  const [, kind, id] = location.hash.replace(/^#/, "").split("/");
  if (kind === "e" && id) openEvent(id);
  else {
    state.eventId = null;
    state.data = null;
    renderHome();
  }
}
window.addEventListener("hashchange", route);

// ---------- home: create an event ----------

function newForm() {
  const today = new Date();
  return {
    name: "",
    dates: new Set(),
    start: 9 * 60,
    end: 21 * 60,
    slot: 30,
    timezone: myTimezone(),
    month: new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)),
  };
}

function renderHome() {
  document.title = t("appName");
  state.form ||= newForm();
  const f = state.form;

  const hourOptions = (from, to, selected) =>
    Array.from({ length: to - from + 1 }, (_, i) => {
      const m = (from + i) * 60;
      return h("option", { value: m, selected: m === selected }, fmtMin(m));
    });

  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [f.timezone];
  if (!timezones.includes(f.timezone)) timezones.unshift(f.timezone);

  const form = h("form", {
    class: "card flex flex-col gap-5",
    onsubmit: async (e) => {
      e.preventDefault();
      if ((f.end - f.start) % f.slot) return toast(t("err_slotFit", { slot: f.slot }));
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const { id } = await api("POST", "/events", {
          name: f.name,
          days: [...f.dates].sort(),
          startMinute: f.start,
          endMinute: f.end,
          slotMinutes: f.slot,
          timezone: f.timezone,
          adminPassword: f.adminPassword || undefined,
        });
        if (f.adminPassword) state.admin.set(id, f.adminPassword);
        state.form = null;
        state.mode = "edit";
        location.hash = `#/e/${id}`;
      } catch (err) {
        showError(err);
      } finally {
        button.disabled = false;
      }
    },
  },
    h("h2", { class: "text-xl font-bold" }, t("newEvent")),
    h("label", { class: "label" }, t("eventName"),
      h("input", { class: "input", required: true, maxlength: 200, placeholder: t("eventNamePh"), value: f.name, oninput: (e) => (f.name = e.target.value) })),
    datePicker(),
    h("div", { class: "grid grid-cols-2 gap-3 sm:grid-cols-4" },
      h("label", { class: "label" }, t("from"),
        h("select", { class: "input", onchange: (e) => (f.start = Number(e.target.value)) }, hourOptions(0, 23, f.start))),
      h("label", { class: "label" }, t("to"),
        h("select", { class: "input", onchange: (e) => (f.end = Number(e.target.value)) }, hourOptions(1, 24, f.end))),
      h("label", { class: "label" }, t("slotSize"),
        h("select", { class: "input", onchange: (e) => (f.slot = Number(e.target.value)) },
          [15, 30, 60, 90, 120, 180].map((m) => h("option", { value: m, selected: m === f.slot }, t("minutes", m))))),
      h("label", { class: "label" }, t("timezone"),
        h("select", { class: "input", onchange: (e) => (f.timezone = e.target.value) },
          timezones.map((tz) => h("option", { value: tz, selected: tz === f.timezone }, tz.replaceAll("_", " "))))),
    ),
    h("label", { class: "label sm:max-w-sm" },
      h("span", null, t("adminPassword"), " ", h("span", { class: "font-normal text-stone-500" }, `(${t("optional")})`)),
      h("input", { class: "input", type: "password", autocomplete: "off", value: f.adminPassword || "", oninput: (e) => (f.adminPassword = e.target.value) }),
      h("span", { class: "text-sm font-normal text-stone-500" }, t("adminPasswordHelp")),
    ),
    h("div", null, h("button", { type: "submit", class: "btn btn-green" }, t("createEvent"))),
  );

  const recentSection = h("div");
  fill(app,
    h("div", { class: "mx-auto flex max-w-3xl flex-col gap-6" },
      h("div", null,
        h("h1", { class: "text-3xl font-bold tracking-tight sm:text-4xl" }, t("tagline")),
        h("p", { class: "mt-2 text-lg text-stone-600" }, t("home_intro")),
      ),
      form,
      recentSection,
      h("p", { class: "text-center text-sm text-stone-500" },
        t("inspiredBy"), " ",
        h("a", { href: "https://timeful.app", target: "_blank", rel: "noopener", class: "underline hover:text-stone-900" }, "timeful.app"),
        " · ",
        h("a", { href: "/privacy", class: "underline hover:text-stone-900" }, t("privacy")),
      ),
    ),
  );
  renderRecent(recentSection);
  refreshRecent().then((changed) => changed && recentSection.isConnected && renderRecent(recentSection), () => {});
}

// "Your recent events": active ones as cards, archived ones behind a small toggle at the end.
function renderRecent(container) {
  const recent = recentEvents();
  const active = recent.filter((e) => !e.archived);
  const archived = recent.filter((e) => e.archived);
  const card = (e) =>
    h("li", null,
      h("a", {
        href: `#/e/${e.id}`,
        class: "card flex items-center gap-3 py-3.5! font-semibold transition hover:ring-stone-400" + (e.archived ? " bg-stone-50! text-stone-500" : ""),
      },
        h("span", { class: "min-w-0 flex-1 truncate" }, e.name),
        e.hasAdminPassword && lockBadge(e.id),
        h("span", { class: "text-stone-400", "aria-hidden": "true" }, "→")),
    );
  fill(container,
    recent.length > 0 && h("section", { class: "flex flex-col gap-3" },
      h("h2", { class: "text-lg font-bold" }, t("recentEvents")),
      active.length > 0 && h("ul", { class: "flex flex-col gap-2" }, active.map(card)),
      archived.length > 0 && h("button", {
        type: "button",
        "aria-expanded": String(state.showArchived),
        class: "self-start cursor-pointer text-sm font-semibold text-stone-500 underline-offset-4 hover:text-stone-900 hover:underline",
        onclick: () => {
          state.showArchived = !state.showArchived;
          renderRecent(container);
        },
      }, state.showArchived ? "▾ " : "▸ ", t("showArchived", archived.length)),
      state.showArchived && archived.length > 0 && h("ul", { class: "flex flex-col gap-2" }, archived.map(card)),
    ),
  );
}

// Month calendar: click toggles a day, dragging adds (or removes, if you started on a picked day).
function datePicker() {
  const f = state.form;
  const todayIso = isoDate(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
  const wrap = h("div", { class: "flex flex-col gap-2 sm:max-w-sm" });
  let drag = null;

  const render = () => {
    const first = f.month;
    const lead = (first.getUTCDay() + 6) % 7; // Monday first
    const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const count = h("span", { class: "text-sm font-medium text-stone-500" }, t("datesPicked", f.dates.size));

    const days = [];
    for (let i = 0; i < lead; i++) days.push(h("span"));
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoDate(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d)));
      const past = iso < todayIso;
      days.push(
        h("button", {
          type: "button",
          "data-iso": iso,
          disabled: past,
          "aria-pressed": String(f.dates.has(iso)),
          class: "aspect-square cursor-pointer rounded-xl text-sm font-semibold transition disabled:cursor-default disabled:text-stone-300 " +
            "aria-pressed:bg-emerald-500 aria-pressed:text-white enabled:hover:ring-2 enabled:hover:ring-emerald-300" +
            (iso === todayIso ? " ring-1 ring-stone-400" : ""),
        }, d),
      );
    }

    const apply = (btn) => {
      if (!btn || btn.disabled) return;
      const iso = btn.dataset.iso;
      if (drag.add) f.dates.add(iso);
      else f.dates.delete(iso);
      btn.setAttribute("aria-pressed", String(drag.add));
      count.textContent = t("datesPicked", f.dates.size);
    };
    const grid = h("div", {
      class: "grid touch-none grid-cols-7 gap-1 select-none",
      onpointerdown: (e) => {
        const btn = e.target.closest("button[data-iso]");
        if (!btn || btn.disabled) return;
        e.preventDefault();
        grid.setPointerCapture(e.pointerId);
        drag = { add: !f.dates.has(btn.dataset.iso) };
        apply(btn);
      },
      onpointermove: (e) => {
        if (drag) apply(document.elementFromPoint(e.clientX, e.clientY)?.closest("button[data-iso]"));
      },
      onpointerup: () => (drag = null),
      onpointercancel: () => (drag = null),
    },
      [1, 2, 3, 4, 5, 6, 7].map((n) =>
        h("span", { class: "pb-1 text-center text-xs font-semibold text-stone-500 uppercase" }, fmtWeekday(weekdayDate(n), "narrow"))),
      days,
    );

    const shiftMonth = (delta) => {
      f.month = new Date(Date.UTC(f.month.getUTCFullYear(), f.month.getUTCMonth() + delta, 1));
      render();
    };
    fill(wrap,
      h("div", { class: "flex items-center gap-2" },
        h("button", { type: "button", class: "btn btn-sm btn-icon", "aria-label": t("prevMonth"), onclick: () => shiftMonth(-1) }, "‹"),
        h("span", { class: "flex-1 text-center font-bold" },
          first.toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" })),
        h("button", { type: "button", class: "btn btn-sm btn-icon", "aria-label": t("nextMonth"), onclick: () => shiftMonth(1) }, "›"),
      ),
      grid,
      h("div", { class: "flex items-center justify-between" },
        count,
        f.dates.size > 0 && h("button", { type: "button", class: "btn btn-sm", onclick: () => (f.dates.clear(), render()) }, t("clearDates")),
      ),
    );
  };
  render();
  return h("div", { class: "flex flex-col gap-2" }, h("p", { class: "text-sm text-stone-500" }, t("pickDates")), wrap);
}

// ---------- event page ----------

async function openEvent(id) {
  if (state.eventId !== id) {
    state.eventId = id;
    state.data = null;
    state.page = 0;
    state.focus = null;
    state.sel = null;
    state.selPinned = false;
    state.confirmDelete = false;
    state.confirmRemove = null;
    state.preview = null;
    state.versions = null;
    state.showHistory = false;
    app.replaceChildren(h("p", { class: "text-stone-500" }, t("loading")));
  }
  try {
    const data = await api("GET", `/events/${id}`);
    if (state.eventId !== id) return;
    state.data = data;
    rememberEvent(data.event);
    const me = data.responses.find((r) => r.id === getStored(`quedamos.me.${id}`));
    state.self = newAnswer(me, getStored("quedamos.name") || "");
    state.edit = state.self;
    if (state.mode === "group" && !data.responses.length) state.mode = "edit";
    if (data.event.archived) state.mode = "group";
    renderEvent();
  } catch (err) {
    if (state.eventId !== id) return;
    app.replaceChildren(
      h("div", { class: "card mx-auto max-w-lg text-center" },
        h("p", { class: "text-lg font-semibold" }, err.message),
        h("a", { href: "#/", class: "btn mt-4" }, "← ", t("newEvent"))),
    );
  }
}

function perDay() {
  const ev = state.data.event;
  return (ev.endMinute - ev.startMinute) / ev.slotMinutes;
}

function slotCount() {
  return state.data.event.days.length * perDay();
}

// An answer as the editor holds it. Saving goes through the object, so a save that's still running
// when the editor switches to another person stays with the right answer.
function newAnswer(response, name = "") {
  return {
    eventId: state.eventId,
    id: response?.id ?? null,
    name: response?.name ?? name,
    values: response ? [...response.slots].map(Number) : new Array(slotCount()).fill(0),
    saveState: "idle", // idle | dirty | saving | saved | needName
    nameTaken: null, // { name, id } after a 409
    timer: null,
  };
}

// All answers, with the ones open in the editor replaced by what's being painted.
// While previewing a past version: that version's answers instead.
function liveResponses() {
  if (state.preview) return state.preview.responses.map((r) => ({ ...r, values: [...r.slots].map(Number) }));
  const drafts = state.edit === state.self ? [state.self] : [state.self, state.edit];
  const list = state.data.responses.map((r) => {
    const draft = drafts.find((d) => d.id === r.id);
    return { ...r, values: draft ? draft.values : [...r.slots].map(Number) };
  });
  for (const d of drafts) {
    if (!d.id && d.values.some(Boolean) && d.name.trim()) list.push({ id: null, name: d.name.trim(), values: d.values, draft: d });
  }
  return list;
}

function keyOf(response) {
  return response.id ?? (response.draft === state.self ? "me" : "new");
}

// Share of the other people (not the one being painted) free per slot, for the editor background.
function othersHeat() {
  const others = liveResponses().filter((r) => (r.id ? r.id !== state.edit.id : r.draft !== state.edit));
  if (!others.length) return null;
  const { av, ifn } = heat(others);
  return Array.from(av, (a, i) => ((a + ifn[i] * 0.5) / others.length).toFixed(3));
}

function heat(responses) {
  const n = slotCount();
  const av = new Uint16Array(n);
  const ifn = new Uint16Array(n);
  for (const r of responses) {
    for (let i = 0; i < n; i++) {
      if (r.values[i] === 1) av[i]++;
      else if (r.values[i] === 2) ifn[i]++;
    }
  }
  return { av, ifn };
}

function dayInfo(d) {
  const ev = state.data.event;
  const v = ev.days[d];
  return { top: fmtWeekday(parseDate(v)), bottom: fmtDayMonth(parseDate(v)), long: `${fmtWeekday(parseDate(v))} ${fmtDayMonth(parseDate(v))}` };
}

function slotLabel(i, len = 1) {
  const ev = state.data.event;
  const d = Math.floor(i / perDay());
  const r = i % perDay();
  const start = ev.startMinute + r * ev.slotMinutes;
  return `${dayInfo(d).long} · ${fmtMin(start)}-${fmtMin(start + len * ev.slotMinutes)}`;
}

function daysPerPage() {
  const width = ui.gridArea?.clientWidth || app.clientWidth;
  const minCol = window.innerWidth < 640 ? 38 : 64;
  return Math.max(1, Math.min(state.data.event.days.length, Math.floor((width - 52) / minCol)));
}

function renderEvent() {
  const ev = state.data.event;
  document.title = `${ev.name} · ${t("appName")}`;
  const n = liveResponses().length;
  const tzDiffers = ev.timezone !== myTimezone();
  const isAdmin = state.admin.has(ev.id);

  ui.gridArea = h("div", { class: "min-w-0 flex-1" });
  ui.panel = h("aside", {
    class: "flex flex-col gap-4 lg:sticky lg:top-20 lg:w-80 lg:flex-none " + (state.mode === "edit" ? "order-first lg:order-none" : ""),
  });
  ui.sheet = h("div", { class: "lg:hidden" });

  fill(app,
    h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
      h("div", { class: "min-w-0" },
        h("h1", { class: "text-3xl font-bold tracking-tight break-words" }, ev.name),
        h("p", { class: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-stone-500" },
          h("span", null, ui.count = h("span", null, t("responses", n)), " · ", t("timesIn", ev.timezone.replaceAll("_", " "))),
          ev.hasAdminPassword && lockBadge(ev.id)),
      ),
      h("div", { class: "flex flex-wrap gap-2" },
        ev.hasAdminPassword && h("button", {
          type: "button",
          class: "btn" + (isAdmin ? " bg-stone-900! text-white! ring-stone-900!" : ""),
          "aria-pressed": String(isAdmin),
          onclick: async () => {
            if (isAdmin) return;
            await unlockAdmin();
            renderEvent();
          },
        }, lockIcon(), isAdmin ? t("adminOn") : t("admin")),
        h("button", { type: "button", class: "btn", onclick: copyLink }, t("copyLink")),
      ),
    ),
    ev.archived && h("div", { class: "mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-stone-200/70 px-4 py-2.5 font-medium text-stone-700" },
      t("archivedBanner"),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => setArchived(false) }, t("unarchive"))),
    state.preview && h("div", { class: "mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-sky-50 px-4 py-2.5 font-medium text-sky-900 ring-1 ring-sky-200" },
      t("viewingVersion", state.preview.number, fmtWhen(state.preview.at)),
      h("div", { class: "flex flex-wrap gap-2" },
        !ev.archived && state.preview.number !== state.versions?.[0]?.number &&
          h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => restoreVersion(state.preview.number) }, t("restore")),
        h("button", { type: "button", class: "btn btn-sm", onclick: closePreview }, t("backToNow")))),
    tzDiffers && h("p", { class: "mt-3 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900 ring-1 ring-amber-200" },
      t("differentTz", ev.timezone.replaceAll("_", " "))),
    h("div", { class: "mt-5 flex flex-wrap items-center justify-between gap-3" },
      h("div", { class: "seg", role: "group" },
        h("button", { type: "button", "aria-pressed": String(state.mode === "group"), onclick: () => setMode("group") }, t("modeGroup")),
        !ev.archived && !state.preview && (ui.modeEdit = h("button", { type: "button", "aria-pressed": String(state.mode === "edit"), onclick: () => setMode("edit") })),
      ),
      ui.pager = h("div", { class: "flex items-center gap-2" }),
    ),
    h("div", { class: "mt-4 flex flex-col gap-6 lg:flex-row lg:items-start" }, ui.gridArea, ui.panel),
    ui.sheet,
    // tucked away at the bottom: most people never need it
    h("div", { class: "mt-16 flex flex-col items-center gap-4" },
      h("button", {
        type: "button",
        class: "cursor-pointer rounded-full px-3 py-1 text-sm font-medium text-stone-400 transition hover:text-stone-700",
        "aria-expanded": String(state.showHistory),
        onclick: toggleHistory,
      }, (state.showHistory ? "▾ " : "▸ ") + t("history")),
      ui.history = state.showHistory ? h("div", { class: "card w-full max-w-2xl" }) : null,
    ),
  );
  renderLabels();
  renderGrid();
  renderPanel();
  renderHistory();
}

// Texts that change while typing a name or after the first save, without a full re-render.
function renderLabels() {
  ui.count.textContent = t("responses", liveResponses().length);
  if (ui.modeEdit) {
    ui.modeEdit.textContent = state.edit === state.self ? t("modeMine") : t("paintingName", state.edit.name.trim() || t("newPerson"));
  }
}

function setMode(mode) {
  if (state.mode === mode) return;
  if (state.mode === "edit") flushSave(state.edit);
  state.edit = state.self; // the editor opens on my own answer unless a person is picked
  state.mode = mode;
  state.sel = null;
  state.focus = null;
  state.confirmDelete = false;
  renderEvent();
}

function eventUrl() {
  return `${location.origin}/#/e/${state.eventId}`;
}

function copyLink() {
  const url = eventUrl();
  navigator.clipboard.writeText(url).then(() => toast(t("linkCopied")), () => prompt(t("copyLink"), url));
}

// ---------- grid ----------

function renderGrid() {
  const ev = state.data.event;
  const rows = perDay();
  const rowH = ROW_HEIGHT[ev.slotMinutes];
  const total = ev.days.length;
  const per = daysPerPage();
  const pages = Math.ceil(total / per);
  state.page = Math.min(state.page, pages - 1);
  const first = state.page * per;
  const last = Math.min(total, first + per);

  fill(ui.pager,
    pages > 1 && h("button", { type: "button", class: "btn btn-sm btn-icon", "aria-label": t("prevDays"), disabled: state.page === 0, onclick: () => turnPage(-1) }, "‹"),
    pages > 1 && h("span", { class: "text-sm font-medium text-stone-500" }, t("daysOf", first + 1, last, total)),
    pages > 1 && h("button", { type: "button", class: "btn btn-sm btn-icon", "aria-label": t("nextDays"), disabled: state.page >= pages - 1, onclick: () => turnPage(1) }, "›"),
  );

  // hour labels on the left
  const times = h("div", { class: "ag-times", style: `grid-row: 2` });
  for (let r = 0; r <= rows; r++) {
    const m = ev.startMinute + r * ev.slotMinutes;
    if (m % 60 === 0 || ev.slotMinutes > 60) times.append(h("span", { class: "ag-time", style: `top:${r * rowH}px` }, fmtMin(m)));
  }

  ui.cells = new Map();
  const heads = [];
  const cols = [];
  for (let d = first; d < last; d++) {
    const info = dayInfo(d);
    // gap between non-consecutive dates
    const gap = d > first && (parseDate(ev.days[d]) - parseDate(ev.days[d - 1])) > 86400000;
    heads.push(
      h("div", { class: "ag-head" + (gap ? " ml-1.5" : "") },
        h("span", { class: "text-xs font-semibold text-stone-500 uppercase" }, info.top),
        h("span", { class: "text-sm font-bold" }, info.bottom),
      ),
    );
    const col = h("div", { class: "ag-col" + (gap ? " gap-before" : "") });
    for (let r = 0; r < rows; r++) {
      const i = d * rows + r;
      const endMinute = ev.startMinute + (r + 1) * ev.slotMinutes;
      const cell = h("div", { class: "cell" + (endMinute % 60 === 0 || ev.slotMinutes > 60 ? " hour-end" : ""), "data-i": i });
      ui.cells.set(i, cell);
      col.append(cell);
    }
    cols.push(col);
  }

  ui.grid = h("div", {
    class: "ag",
    style: `--cols:${last - first};--row-h:${rowH}px;grid-template-rows:auto ${rows * rowH}px`,
    onpointerdown: onGridDown,
    onpointermove: onGridMove,
    onpointerup: onGridUp,
    onpointercancel: onGridUp,
    onpointerleave: () => {
      if (state.mode === "group" && !state.selPinned) selectSlot(null);
    },
  }, h("div"), heads, times, cols);

  ui.gridArea.replaceChildren(ui.grid);
  paintGrid();
}

function turnPage(delta) {
  state.page += delta;
  renderGrid();
}

// Fill cell colors for the current mode without rebuilding the DOM.
function paintGrid() {
  const grid = ui.grid;
  const editing = state.mode === "edit";
  const focus = !editing && state.focus ? liveResponses().find((r) => keyOf(r) === state.focus) : null;
  const ghost = editing && state.ghost ? othersHeat() : null;
  grid.classList.toggle("editing", editing);
  grid.classList.toggle("group", !editing && !focus);
  grid.classList.toggle("ghost", !!ghost);

  if (editing || focus) {
    const values = editing ? state.edit.values : focus.values;
    for (const [i, cell] of ui.cells) {
      if (ghost) cell.style.setProperty("--a", ghost[i]);
      else cell.style.removeProperty("--a");
      cell.classList.remove("all");
      if (values[i]) cell.dataset.v = values[i];
      else delete cell.dataset.v;
    }
  } else {
    const responses = liveResponses();
    const n = responses.length;
    const { av, ifn } = heat(responses);
    for (const [i, cell] of ui.cells) {
      delete cell.dataset.v;
      cell.style.setProperty("--a", n ? ((av[i] + ifn[i] * 0.5) / n).toFixed(3) : 0);
      cell.classList.toggle("all", n > 0 && av[i] === n);
    }
  }
  markSelection();
}

// ---------- painting (edit mode) ----------

let drag = null; // { a, b, value, previewed: Set }

function cellAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cell = el?.closest?.(".cell");
  return cell && ui.grid.contains(cell) ? Number(cell.dataset.i) : null;
}

function onGridDown(e) {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const i = Number(cell.dataset.i);
  if (state.mode !== "edit") {
    state.selPinned = !(state.selPinned && state.sel === i);
    selectSlot(state.selPinned ? i : null);
    return;
  }
  e.preventDefault();
  ui.grid.setPointerCapture(e.pointerId);
  // starting on a slot already painted with the current brush erases instead
  drag = { a: i, b: i, value: state.edit.values[i] === state.brush ? 0 : state.brush, previewed: new Set() };
  previewDrag();
}

function onGridMove(e) {
  if (state.mode !== "edit") {
    if (!state.selPinned && e.pointerType === "mouse") {
      const i = cellAt(e);
      if (i !== state.sel) selectSlot(i);
    }
    return;
  }
  if (!drag) return;
  const i = cellAt(e);
  if (i != null && i !== drag.b) {
    drag.b = i;
    previewDrag();
  }
}

function onGridUp() {
  if (!drag) return;
  for (const i of dragRect()) state.edit.values[i] = drag.value;
  for (const i of drag.previewed) delete ui.cells.get(i)?.dataset.p;
  drag = null;
  paintGrid();
  scheduleSave();
}

// Indices inside the rectangle spanned by the drag start and the current cell.
function dragRect() {
  const rows = perDay();
  const [d1, d2] = [Math.floor(drag.a / rows), Math.floor(drag.b / rows)].sort((x, y) => x - y);
  const [r1, r2] = [drag.a % rows, drag.b % rows].sort((x, y) => x - y);
  const out = [];
  for (let d = d1; d <= d2; d++) for (let r = r1; r <= r2; r++) out.push(d * rows + r);
  return out;
}

function previewDrag() {
  const rect = new Set(dragRect());
  for (const i of drag.previewed) if (!rect.has(i)) delete ui.cells.get(i)?.dataset.p;
  for (const i of rect) {
    const cell = ui.cells.get(i);
    if (cell) cell.dataset.p = drag.value;
  }
  drag.previewed = rect;
}

// ---------- saving ----------

// Answers waiting to be sent, one request at a time, in order.
const saveQueue = new Set();
let saving = false;

function scheduleSave(answer = state.edit, delay = 600) {
  answer.saveState = "dirty";
  renderStatus();
  clearTimeout(answer.timer);
  answer.timer = setTimeout(() => queueSave(answer), delay);
}

function flushSave(answer = state.edit) {
  if (answer.saveState !== "dirty") return;
  clearTimeout(answer.timer);
  queueSave(answer);
}

async function queueSave(answer) {
  saveQueue.add(answer);
  if (saving) return;
  saving = true;
  while (saveQueue.size) {
    const next = saveQueue.values().next().value;
    saveQueue.delete(next);
    await save(next);
  }
  saving = false;
}

async function save(answer) {
  const name = answer.name.trim();
  if (!name) {
    answer.saveState = "needName";
    renderStatus();
    return;
  }
  answer.saveState = "saving";
  renderStatus();
  const { eventId } = answer;
  const isSelf = answer === state.self;
  const created = !answer.id;
  const body = { name, slots: answer.values.join(""), ...editAuth(answer) };
  try {
    let res;
    try {
      res = answer.id
        ? await api("PUT", `/events/${eventId}/responses/${answer.id}`, body)
        : await api("POST", `/events/${eventId}/responses`, body);
    } catch (err) {
      if (err.code !== "responseNotFound" || !isSelf) throw err;
      res = await api("POST", `/events/${eventId}/responses`, body); // deleted elsewhere: answer again
    }
    const { editToken, ...saved } = res;
    answer.id = saved.id;
    answer.nameTaken = null;
    if (answer.saveState === "saving") answer.saveState = "saved"; // else painted on meanwhile: still dirty
    if (editToken) setToken(eventId, saved.id, editToken);
    if (isSelf) {
      setStored(`quedamos.me.${eventId}`, saved.id);
      setStored("quedamos.name", name);
    }
    if (state.eventId !== eventId) return;
    const responses = state.data.responses;
    const idx = responses.findIndex((r) => r.id === saved.id);
    if (idx >= 0) responses[idx] = saved;
    else responses.push(saved);
    renderLabels();
    if (created && answer === state.edit) renderPanel(); // the new person's chip and remove button
  } catch (err) {
    if (err.code === "nameTaken") {
      answer.nameTaken = err.params;
      answer.saveState = "idle";
      if (answer === state.edit) renderPanel();
    } else {
      answer.saveState = "dirty";
      showError(err);
    }
  } finally {
    renderStatus();
  }
}

// Proof that we may change an answer: its edit token from this browser, plus the admin password if unlocked.
function editAuth(answer) {
  return { editToken: tokenFor(answer.eventId, answer.id), adminPassword: state.admin.get(answer.eventId) };
}

function renderStatus() {
  if (!ui.status || !state.edit) return;
  const st = state.edit.saveState;
  const needName = state.edit === state.self ? t("unsaved") : t("unsavedOther");
  ui.status.textContent = { dirty: t("saving"), saving: t("saving"), saved: t("saved"), needName }[st] || "";
  ui.status.className = "text-sm font-semibold " + (st === "needName" ? "text-rose-700" : st === "saved" ? "text-emerald-700" : "text-stone-500");
}

// ---------- side panel ----------

function renderPanel() {
  // keep typing in the name field when the panel re-renders under it (first save, name clash)
  const active = ui.panel.contains(document.activeElement) && document.activeElement.matches("input.input") ? document.activeElement : null;
  const caret = active?.selectionStart;
  ui.status = null;
  ui.info = null;
  fill(ui.panel, ...(state.mode === "edit" ? editPanel() : groupPanel()));
  if (active) {
    const input = ui.panel.querySelector("input.input");
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
  renderStatus();
  renderInfo();
}

// People this browser can paint for besides me: everyone as admin, otherwise the ones it added.
function otherPeople() {
  const ev = state.data.event;
  const isAdmin = state.admin.has(ev.id);
  return state.data.responses.filter((r) => r.id !== state.self.id && (isAdmin || tokenFor(ev.id, r.id)));
}

// Point the editor at another answer. Unsaved strokes of the current one are sent first.
function switchTo(answer) {
  flushSave(state.edit);
  state.edit = answer;
  state.confirmDelete = false;
  state.mode = "edit";
  state.focus = null;
  state.sel = null;
  renderEvent();
}

// "Painting for": me, the people I can paint for, and "+ Add person".
function personChips() {
  const edit = state.edit;
  const ev = state.data.event;
  const chip = (answer, label, onclick, extra) => {
    const pressed = answer === edit;
    const text = h("span", { class: "truncate" }, label);
    const pic = avatar(answer.name.trim() || "?");
    if (pressed) Object.assign(ui, { chipLabel: text, chipAvatar: pic });
    return h("button", {
      type: "button",
      class: "chip",
      "aria-pressed": String(pressed),
      onclick: pressed ? null : onclick,
    }, pic, text, extra);
  };
  const others = otherPeople().map((r) => (r.id === edit.id ? edit : newAnswer(r)));
  if (edit !== state.self && !edit.id) others.push(edit); // being added, not saved yet
  return h("div", { class: "-mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5 lg:flex-wrap" },
    chip(state.self, state.self.name.trim() || t("you"), () => switchTo(state.self),
      h("span", { class: "opacity-60" }, `(${t("you")})`)),
    others.map((a) =>
      chip(a, a.name.trim() || t("newPerson"), () => switchTo(a),
        a.id && !tokenFor(ev.id, a.id) && h("span", { class: "opacity-60", title: t("admin") }, lockIcon()))),
    h("button", {
      type: "button",
      class: "chip chip-add",
      onclick: () => {
        switchTo(newAnswer(null));
        ui.panel.querySelector("input.input")?.focus();
      },
    }, "+ ", t("addPerson")),
  );
}

function editPanel() {
  const answer = state.edit;
  const isSelf = answer === state.self;
  const ev = state.data.event;
  ui.chipLabel = null;
  const nameInput = h("input", {
    class: "input",
    maxlength: 100,
    placeholder: isSelf ? t("yourNamePh") : t("personNamePh"),
    value: answer.name,
    autocomplete: isSelf ? "name" : "off",
    oninput: (e) => {
      answer.name = e.target.value;
      answer.nameTaken = null;
      if (ui.chipLabel) {
        ui.chipLabel.textContent = answer.name.trim() || (isSelf ? t("you") : t("newPerson"));
        ui.chipAvatar.replaceWith((ui.chipAvatar = avatar(answer.name.trim() || "?")));
      }
      renderLabels();
      if (answer.name.trim() && (answer.id || answer.values.some(Boolean))) scheduleSave(answer, 900);
    },
  });
  const brushes = h("div", { class: "seg", role: "group" },
    [[1, "brushAvailable", "swatch-av"], [2, "brushIfNeeded", "swatch-if"]].map(([value, key, swatch]) =>
      h("button", {
        type: "button",
        "aria-pressed": String(state.brush === value),
        onclick: (e) => {
          state.brush = value;
          brushes.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
        },
      }, h("span", { class: `swatch ${swatch}` }), t(key)),
    ),
  );
  ui.status = h("span");

  const taken = answer.nameTaken;
  const canTakeOver = !ev.hasAdminPassword || state.admin.has(state.eventId) || (taken && tokenFor(ev.id, taken.id));
  const hasOthers = liveResponses().some((r) => (r.id ? r.id !== answer.id : r.draft !== answer));
  return [
    h("div", { class: "card flex flex-col gap-4" },
      h("div", { class: "flex flex-col gap-1.5" },
        h("span", { class: "text-sm font-semibold text-stone-700" }, t("paintingFor")),
        personChips()),
      h("label", { class: "label" }, isSelf ? t("yourName") : t("personName"), nameInput),
      taken && h("div", { class: "flex flex-col gap-2 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200" },
        h("p", { class: "font-semibold" }, t("nameTakenTitle", taken.name)),
        h("p", { class: "text-sm text-stone-600" }, canTakeOver ? t("nameTakenText") : t("nameTakenProtected")),
        h("div", { class: "flex flex-wrap gap-2" },
          canTakeOver && h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => adoptResponse(taken.id) },
            isSelf ? t("thatsMe") : t("useExisting")),
          h("button", {
            type: "button",
            class: "btn btn-sm",
            onclick: () => {
              answer.nameTaken = null;
              renderPanel();
              ui.panel.querySelector("input.input")?.select();
            },
          }, t("otherName")),
        ),
      ),
      h("div", { class: "flex flex-col items-start gap-2" }, brushes, h("p", { class: "text-sm text-stone-500" }, t("paintHint"))),
      hasOthers && h("label", { class: "flex cursor-pointer items-center gap-2 text-sm font-medium text-stone-600" },
        h("input", {
          type: "checkbox",
          class: "size-4 accent-emerald-600",
          checked: state.ghost,
          onchange: (e) => {
            state.ghost = e.target.checked;
            setStored("quedamos.ghost", state.ghost ? null : "0");
            paintGrid();
          },
        }),
        t("showOthers"),
        h("span", { class: "ghost-legend ml-auto h-3 w-10 flex-none rounded ring-1 ring-stone-200", title: t("othersFree") })),
      h("div", { class: "flex flex-wrap items-center justify-between gap-2" },
        ui.status,
        h("button", { type: "button", class: "btn btn-green", onclick: () => setMode("group") }, t("done")),
      ),
    ),
    h("div", { class: "flex flex-wrap gap-2" },
      h("button", {
        type: "button",
        class: "btn btn-sm",
        onclick: () => {
          answer.values.fill(0);
          paintGrid();
          if (answer.id) scheduleSave(answer);
        },
      }, t("clearAll")),
      answer.id && h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: deleteAnswer },
        isSelf
          ? (state.confirmDelete ? t("deleteConfirm") : t("deleteMine"))
          : (state.confirmDelete ? t("removePersonConfirm", answer.name) : t("removePerson", answer.name))),
    ),
  ];
}

// After a name clash: continue with the existing answer ("That's me"). Keep what was just painted, if anything.
function adoptResponse(id) {
  const answer = state.edit;
  const existing = state.data.responses.find((r) => r.id === id);
  answer.id = id;
  answer.nameTaken = null;
  if (answer === state.self) setStored(`quedamos.me.${state.eventId}`, id);
  if (existing && answer.values.some(Boolean)) scheduleSave(answer, 0);
  else if (existing) answer.values = [...existing.slots].map(Number);
  paintGrid();
  renderPanel();
}

async function deleteAnswer() {
  const answer = state.edit;
  if (!state.confirmDelete) {
    state.confirmDelete = true;
    renderPanel();
    return;
  }
  try {
    clearTimeout(answer.timer);
    saveQueue.delete(answer);
    await api("DELETE", `/events/${state.eventId}/responses/${answer.id}`, editAuth(answer));
    toast(answer === state.self ? t("deleted") : t("removed", answer.name));
    forgetAnswer(answer.id);
    renderEvent();
  } catch (err) {
    showError(err);
  }
}

// Drop a deleted answer here too: from the list, this browser's tokens and the editor.
function forgetAnswer(id) {
  state.data.responses = state.data.responses.filter((r) => r.id !== id);
  setToken(state.eventId, id, null);
  state.confirmDelete = false;
  if (state.focus === id) state.focus = null;
  if (id === state.self.id) {
    clearTimeout(state.self.timer);
    saveQueue.delete(state.self);
    Object.assign(state.self, { id: null, saveState: "idle", nameTaken: null });
    state.self.values.fill(0);
    setStored(`quedamos.me.${state.eventId}`, null);
    setStored(`quedamos.token.${state.eventId}`, null);
  }
  if (state.edit.id === id) state.edit = state.self;
}

function groupPanel() {
  const responses = liveResponses();
  const n = responses.length;
  ui.info = h("div", { class: "card hidden flex-col gap-3 lg:flex" });

  const ev = state.data.event;
  const isAdmin = state.admin.has(ev.id) && !ev.archived && !state.preview;
  const people = h("ul", { class: "flex flex-col gap-0.5" },
    responses.map((r) => {
      const key = keyOf(r);
      const isMe = r.id && r.id === state.self.id;
      const canEdit = !ev.archived && !state.preview && r.id && !isMe && (isAdmin || tokenFor(ev.id, r.id));
      return h("li", { class: "flex items-center gap-1" },
        h("button", {
          type: "button",
          "aria-pressed": String(state.focus === key),
          class: "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 text-left font-medium transition hover:bg-stone-100 aria-pressed:bg-emerald-50 aria-pressed:ring-1 aria-pressed:ring-emerald-300",
          onclick: () => {
            state.focus = state.focus === key ? null : key;
            renderPanel();
            paintGrid();
          },
        }, avatar(r.name), h("span", { class: "truncate" }, r.name), isMe && h("span", { class: "text-sm text-stone-400" }, `(${t("you")})`)),
        canEdit && h("button", {
          type: "button",
          class: "btn btn-sm btn-icon flex-none ring-0!",
          title: t("editAnswer", r.name),
          "aria-label": t("editAnswer", r.name),
          onclick: () => switchTo(newAnswer(r)),
        }, "✎"),
        isAdmin && r.id && h("button", {
          type: "button",
          class: "btn btn-sm flex-none ring-0! btn-danger " + (state.confirmRemove === r.id ? "bg-rose-50! text-rose-700!" : "btn-icon"),
          title: t("removeAnswer", r.name),
          "aria-label": t("removeAnswer", r.name),
          onclick: () => removeResponse(r),
        }, state.confirmRemove === r.id ? t("removeConfirm") : "×"),
      );
    }),
  );

  const best = bestTimes(responses);
  return [
    ui.info,
    h("div", { class: "card flex flex-col gap-3" },
      h("div", { class: "flex items-center justify-between gap-2" },
        h("h2", { class: "font-bold" }, t("responses", n)),
        n > 0 && h("div", { class: "flex items-center gap-1.5 text-xs font-semibold text-stone-500" },
          "0", h("span", { class: "heat-legend h-3 w-16 rounded ring-1 ring-stone-200" }), `${n}`),
      ),
      n === 0 && h("p", { class: "text-stone-500" }, t("noResponses")),
      people,
      state.focus && h("button", { type: "button", class: "btn btn-sm", onclick: () => ((state.focus = null), renderPanel(), paintGrid()) }, t("showAll")),
      !ev.archived && !state.preview && h("button", { type: "button", class: "btn btn-green", onclick: () => setMode("edit") },
        state.self.id ? t("editMine") : t("addMine")),
      isAdmin && h("button", { type: "button", class: "btn btn-sm", onclick: () => setArchived(true) }, t("archive")),
    ),
    n > 0 && h("div", { class: "card flex flex-col gap-2" },
      h("h2", { class: "font-bold" }, t("bestTimes")),
      best.length
        ? h("ul", { class: "flex flex-col gap-1" },
          best.map((b) =>
            h("li", null,
              h("button", {
                type: "button",
                class: "flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition hover:bg-stone-100",
                onclick: () => showSlot(b.start, b.len),
              }, h("span", { class: "font-medium" }, slotLabel(b.start, b.len)),
                h("span", { class: "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800" }, t("ofPeople", b.av, n))),
            ),
          ))
        : h("p", { class: "text-sm text-stone-500" }, t("noBestTimes")),
    ),
  ];
}

// ---------- admin ----------

async function removeResponse(response) {
  if (state.confirmRemove !== response.id) {
    state.confirmRemove = response.id;
    renderPanel();
    return;
  }
  state.confirmRemove = null;
  try {
    await api("DELETE", `/events/${state.eventId}/responses/${response.id}`, { adminPassword: state.admin.get(state.eventId) });
    forgetAnswer(response.id);
    toast(t("removed", response.name));
    renderEvent();
  } catch (err) {
    showError(err);
    renderPanel();
  }
}

// Archiving and unarchiving always ask for the password, even when admin is already unlocked.
async function setArchived(archived) {
  const eventId = state.eventId;
  const pw = await askAdmin(t(archived ? "archiveText" : "unarchiveText"), (p) =>
    api("POST", `/events/${eventId}/archive`, { adminPassword: p, archived }));
  if (state.eventId !== eventId) return;
  if (!pw) {
    renderEvent(); // a hint may have been revealed
    return;
  }
  state.data.event.archived = archived;
  rememberEvent(state.data.event);
  if (archived) state.mode = "group";
  toast(t(archived ? "archivedToast" : "unarchivedToast"));
  renderEvent();
}

// Contiguous runs with the best score (available = 2, if needed = 1), up to 5.
function bestTimes(responses) {
  if (!responses.length) return [];
  const { av, ifn } = heat(responses);
  const rows = perDay();
  const score = (i) => av[i] * 2 + ifn[i];
  let max = 0;
  for (let i = 0; i < av.length; i++) max = Math.max(max, score(i));
  if (!max) return [];
  const runs = [];
  for (let i = 0; i < av.length; i++) {
    if (score(i) !== max) continue;
    const prev = runs.at(-1);
    if (prev && prev.start + prev.len === i && i % rows !== 0) prev.len++;
    else runs.push({ start: i, len: 1, av: av[i] });
  }
  return runs.sort((a, b) => b.len - a.len).slice(0, 5).sort((a, b) => a.start - b.start);
}

// Jump to a slot (from "best times"): turn to its page and pin it with the whole run.
function showSlot(i, len) {
  const d = Math.floor(i / perDay());
  const per = daysPerPage();
  if (Math.floor(d / per) !== state.page) {
    state.page = Math.floor(d / per);
    renderGrid();
  }
  state.selPinned = true;
  selectSlot(i, { start: i, len });
  ui.cells.get(i)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function selectSlot(i, range) {
  state.sel = i;
  state.selRange = i == null ? null : range || rangeAround(i, liveResponses());
  state.exportOpen = false;
  markSelection();
  renderInfo();
}

function markSelection() {
  const r = state.sel == null ? null : state.selRange;
  for (const [i, cell] of ui.cells) {
    const inside = !!r && i >= r.start && i < r.start + r.len;
    cell.classList.toggle("sel", inside);
    cell.classList.toggle("sel-top", inside && i === r.start);
    cell.classList.toggle("sel-bot", inside && i === r.start + r.len - 1);
  }
}

// The slots around i on the same day where exactly the same people are free (tap 19:30 -> 19:00-21:00).
function rangeAround(i, responses) {
  const rows = perDay();
  const sig = (k) => responses.map((r) => r.values[k] || 0).join("");
  const own = sig(i);
  let start = i;
  let end = i;
  while (start % rows && sig(start - 1) === own) start--;
  while ((end + 1) % rows && sig(end + 1) === own) end++;
  return { start, len: end - start + 1 };
}

// Names by what they can do for the whole range: 1 = available throughout, 2 = at least if needed, 0 = not.
function whoCanMake({ start, len }, responses) {
  const out = { 1: [], 2: [], 0: [] };
  for (const r of responses) {
    const v = Array.from({ length: len }, (_, k) => r.values[start + k] || 0);
    out[v.every((x) => x === 1) ? 1 : v.every(Boolean) ? 2 : 0].push(r.name);
  }
  return out;
}

// Who can make the selected slot: in the side panel (desktop) and a bottom sheet (phones).
function renderInfo() {
  if (state.mode !== "group") {
    ui.sheet?.replaceChildren();
    return;
  }
  const i = state.sel;
  const range = state.selRange;
  const who = i == null ? null : whoCanMake(range, liveResponses());
  const groups = [[1, "available", "swatch-av"], [2, "ifNeeded", "swatch-if"], [0, "unavailable", "bg-stone-200"]];
  const body = (inSheet) =>
    i == null
      ? [h("p", { class: "text-sm text-stone-500" }, t("hoverHint"))]
      : [
        h("div", { class: "flex items-start justify-between gap-2" },
          h("p", { class: "pt-1.5 font-bold" }, slotLabel(range.start, range.len)),
          h("div", { class: "flex flex-none gap-1" },
            state.selPinned && h("button", {
              type: "button",
              class: "btn btn-sm btn-icon" + (state.exportOpen ? " bg-stone-900! text-white! ring-stone-900!" : ""),
              title: t("exportSlot"),
              "aria-label": t("exportSlot"),
              "aria-expanded": String(state.exportOpen),
              onclick: () => {
                state.exportOpen = !state.exportOpen;
                renderInfo();
              },
            }, calendarIcon()),
            inSheet && h("button", {
              type: "button",
              class: "btn btn-sm btn-icon",
              "aria-label": t("close"),
              onclick: () => ((state.selPinned = false), selectSlot(null)),
            }, "×"),
          ),
        ),
        state.selPinned && state.exportOpen && h("div", { class: "flex flex-col gap-1.5 rounded-2xl bg-stone-100 p-2" },
          h("a", { class: "btn btn-sm justify-start", href: googleCalendarUrl(range, who), target: "_blank", rel: "noopener" }, t("addToGoogle")),
          h("button", { type: "button", class: "btn btn-sm justify-start", onclick: () => downloadIcs(range, who) }, t("downloadIcs")),
        ),
        ...groups.map(([v, key, swatch]) => {
          const names = who[v];
          return h("div", { class: "flex flex-col gap-1" },
            h("p", { class: "flex items-center gap-2 text-sm font-semibold text-stone-600" },
              h("span", { class: `swatch ${swatch}` }), `${t(key)} (${names.length})`),
            h("p", { class: "text-sm " + (v === 0 ? "text-stone-400" : "") }, names.length ? names.join(", ") : "-"),
          );
        }),
      ];
  if (ui.info) ui.info.replaceChildren(...body(false));
  fill(ui.sheet,
    i != null
      ? h("div", { class: "card pointer-events-auto fixed inset-x-3 bottom-3 z-30 flex max-h-[45vh] flex-col gap-3 overflow-auto shadow-2xl sm:right-auto sm:w-96" },
        ...body(true))
      : "",
  );
}

function calendarIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "size-4");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.75 4.5c0-.7.55-1.25 1.25-1.25h8c.7 0 1.25.55 1.25 1.25v7.5c0 .7-.55 1.25-1.25 1.25H4c-.7 0-1.25-.55-1.25-1.25Zm0 2.25h10.5M5.5 1.75v2.5m5-2.5v2.5M8 8.5v3m-1.5-1.5h3"/>';
  return svg;
}

// ---------- calendar export ----------

// Start and end as wall-clock time in the event's time zone, stored in UTC fields.
function rangeTimes({ start, len }) {
  const ev = state.data.event;
  const rows = perDay();
  const from = parseDate(ev.days[Math.floor(start / rows)]).getTime() + (ev.startMinute + (start % rows) * ev.slotMinutes) * 60000;
  return { from, to: from + len * ev.slotMinutes * 60000 };
}

function calendarDetails(who) {
  return [
    who[1].length && t("calCanMake", who[1].join(", ")),
    who[2].length && t("calIfNeeded", who[2].join(", ")),
    eventUrl(),
  ].filter(Boolean).join("\n");
}

function googleCalendarUrl(range, who) {
  const ev = state.data.event;
  const { from, to } = rangeTimes(range);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.name,
    dates: `${calStamp(from)}/${calStamp(to)}`,
    ctz: ev.timezone,
    details: calendarDetails(who),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function downloadIcs(range, who) {
  const ev = state.data.event;
  const { from, to } = rangeTimes(range);
  const text = icsText({
    uid: `${ev.id}-${from}@quedamos`, from, to, timeZone: ev.timezone,
    summary: ev.name, description: calendarDetails(who), url: eventUrl(),
  });
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const link = h("a", { href: URL.createObjectURL(blob), download: `${ev.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "quedamos"}.ics` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- version history ----------

function toggleHistory() {
  state.showHistory = !state.showHistory;
  if (state.showHistory) loadHistory();
  renderEvent();
}

async function loadHistory() {
  const eventId = state.eventId;
  try {
    const { versions } = await api("GET", `/events/${eventId}/versions`);
    if (state.eventId !== eventId) return;
    state.versions = versions;
    if (state.preview) renderEvent(); // shows "Restore" once it's known the preview isn't the latest
    else renderHistory();
  } catch (err) {
    showError(err);
  }
}

function renderHistory() {
  if (!ui.history) return;
  const list = state.versions;
  if (!list) {
    fill(ui.history, h("p", { class: "text-stone-500" }, t("loading")));
    return;
  }
  const latest = list[0]?.number;
  fill(ui.history,
    h("p", { class: "mb-3 text-sm text-stone-500" }, t("historyHint")),
    h("ol", { class: "flex flex-col" },
      list.map((v) =>
        h("li", {
          class: "flex items-center justify-between gap-3 rounded-xl px-2 py-2 " + (state.preview?.number === v.number ? "bg-sky-50 ring-1 ring-sky-200" : ""),
        },
          h("div", { class: "min-w-0" },
            h("div", { class: "text-xs font-semibold text-stone-500" }, `#${v.number} · ${fmtWhen(v.at)} · ${t("people", v.people)}`),
            h("div", { class: "font-medium break-words" }, t(`v_${v.kind}`, v.subject)),
          ),
          v.number === latest
            ? h("span", { class: "badge flex-none bg-emerald-100 text-emerald-800" }, t("current"))
            : h("button", { type: "button", class: "btn btn-sm flex-none", onclick: () => previewVersion(v.number) }, t("view")),
        ),
      ),
    ),
  );
}

// Show a past version's answers in the grid (read-only) with a banner to restore it.
async function previewVersion(number) {
  const eventId = state.eventId;
  try {
    const version = await api("GET", `/events/${eventId}/versions/${number}`);
    if (state.eventId !== eventId) return;
    if (state.mode === "edit") flushSave(state.edit);
    state.edit = state.self;
    state.mode = "group";
    state.preview = version;
    state.focus = null;
    state.sel = null;
    state.selPinned = false;
    renderEvent();
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err);
  }
}

function closePreview() {
  state.preview = null;
  state.focus = null;
  state.sel = null;
  renderEvent();
}

async function restoreVersion(number) {
  const ev = state.data.event;
  const eventId = ev.id;
  const restore = (pw) => api("POST", `/events/${eventId}/versions/${number}/restore`, { adminPassword: pw });
  try {
    if (!ev.hasAdminPassword) await restore();
    else if (state.admin.has(eventId)) await restore(state.admin.get(eventId));
    else if (!(await askAdmin(t("restoreText", number), restore))) {
      renderEvent(); // a hint may have been revealed
      return;
    }
  } catch (err) {
    showError(err);
    return;
  }
  if (state.eventId !== eventId) return;
  state.preview = null;
  toast(t("restored", number));
  await openEvent(eventId);
  if (state.showHistory) loadHistory();
}

// ---------- boot ----------

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data && ui.grid?.isConnected && !drag) renderGrid();
  }, 150);
});

route();
