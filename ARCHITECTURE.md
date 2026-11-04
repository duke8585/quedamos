# Architecture

## Cloudflare setup

```
browser ──► Worker "quedamos" (quedamos.egregore85.workers.dev)
              ├─ /api/*      → src/worker.js (JSON API) ──► D1 "quedamos-db"
              └─ everything else → static assets from public/ (ASSETS binding)
(planned) browser ──► Google Calendar API directly, never via the Worker
```

| Piece | What / where |
|---|---|
| Worker | `quedamos`, single file `src/worker.js`, no runtime deps |
| Database | D1 `quedamos-db`, binding `DB` |
| Build / versioning / logs | Tailwind CLI + self-hosted Inter on build, `x-app-version` reload banner, Workers Logs on |
| Tests | `npm test`: vitest, API tests run the real worker in the Workers runtime against a local D1 (`@cloudflare/vitest-plugin`), plus unit tests for `public/calendar.js` |

## Data model

- `events`: `days` = dates (`["2026-11-02", …]`), daily window `start_minute`-`end_minute`, `slot_minutes` (15/30/60/90/120/180, the window must be a multiple), `timezone`. `kind` is always `dates`: a "usual week" mode with weekdays instead of dates existed until migration 0004.
- `events` also has `admin_password_hash` (PBKDF2), `admin_password_hint` (masked, e.g. `q******s`) and `archived_at`.
- `responses`: one row per person, `name` unique per event (case-insensitive), `slots` = one char per (day, slot), day-major: `0` no, `1` available, `2` if needed. A week of 15-min slots is a few hundred bytes. `edit_token_hash` = SHA-256 of the token kept in the answering browser.
- `versions`: numbered JSON snapshots of all answers per event (see Versions below). `admin_failures`: wrong admin passwords per event + IP.

## Design decisions
- **Versions.** `versions` holds a JSON snapshot of all answers (incl. edit token hashes) after every change. Autosave fires every few hundred ms while painting, so an edit of the same answer within 15 minutes of that answer's previous version updates it instead of adding one: the atom is "a painting session of one person". Restore replaces all answers with the snapshot and adds a `restored` version itself (undoable). Restore needs the admin password on protected events; archive state is not versioned.
- **Painting for others.** Edit tokens are kept per answer (`quedamos.tokens.<eventId>` = {responseId: token}), so a browser can add and later edit other people. The editor works on answer objects (`newAnswer`) and saves through a queue, so switching people mid-save can't mix up slots.

- **No accounts.** You type your name. The browser remembers which response is yours per event (`localStorage`), so you can come back and edit. A second person using the same name gets a 409 and a "That's me / use another name" choice instead of silently overwriting.
- **Optional admin password per event**, set on creation (PBKDF2-SHA256, salted, 100k iterations). The admin can edit or remove anyone's answer and archive / unarchive the event. Wrong tries are counted per event + client IP (`admin_failures`); from the 3rd one on, the 403 carries the masked password (first + last character, real length, e.g. `q******s`), and a correct password resets the count. The browser remembers a revealed hint and shows it in the 🔒 badge (event header + recent card); before that the badge just says "Protected".
- **Who may change an answer.** Without an admin password: anyone with the link. With one: the browser that created the answer (edit token in localStorage) or the admin. So on a protected event, "That's me" after a name clash only works for the admin; others pick another name.
- **Archiving** needs the admin password, asked every time (archive and unarchive), even when admin mode is already unlocked; only protected events can be archived. Archived events are read-only (writes get 409). The home page lists them behind a "Show archived" toggle, with flags refreshed via `GET /api/events?ids=…`.
- **Autosave**, debounced, after every paint stroke. No save button.
- **Painting = rectangles.** Drag from one cell to another fills the rectangle. Starting on a cell that already has the current brush erases. Pointer events + `elementFromPoint`, so touch works; the grid has `touch-action: none` only in edit mode.
- **Heatmap on the client**: share = (available + ½ × if needed) / responses, mixed from white to emerald-600; slots where everyone is available get emerald-700.
- **Pagination instead of horizontal scroll**: as many days per page as fit (38px min per column on phones, 64px otherwise). Horizontal scrolling and painting don't mix on touch.
- **Times are shown in the event's time zone** (with a warning if yours differs). Converting to the viewer's zone is a TODO.
- **Event links are 10-char random ids** (no 0/O/1/l/I). There is no public list of events; "your recent events" lives in localStorage.

## Gotchas learned

- Password managers save one password per site unless the form has a username. The password dialog has a hidden username field set to the event id, so passwords are saved and filled per event.
- Event ids are case-sensitive; don't retype them.
