# Quedamos

¿Quedamos? - "shall we meet?". A no-login when-can-everyone-meet tool: pick days (specific dates or a usual week), share the link, everyone paints their availability, and the group view shows a heatmap (greener = more people). Cloudflare Worker (API) + D1 + vanilla JS frontend styled with Tailwind v4, no runtime dependencies.

Live: https://quedamos.egregore85.workers.dev

Inspired by [timeful.app](https://timeful.app).

## Develop

```sh
npm install
npm run db:migrate:local
npm run dev             # http://localhost:8787
npm test                # API + calendar tests, all local
```

## Deploy

```sh
npm run db:migrate:remote   # applies new files in migrations/
npm run deploy
```

Cloudflare setup, data model and design decisions: [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

- `src/worker.js` - `/api/*` handlers; everything else is served from `public/`
- `public/` - SPA (`index.html`, `app.js`, `i18n.js`, `calendar.js`), hash routing `#/e/:id`
- `src/styles.css` - Tailwind entry: theme, component classes, availability grid
- `migrations/` - D1 schema (`events`, `responses`, `admin_failures`, `versions`)
- `test/` - vitest: `api.test.js` (worker + local D1), `calendar.test.js` (time zones, .ics)
