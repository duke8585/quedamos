-- Wrong admin passwords per event and client IP. From the 3rd one on, the masked hint is sent along.
CREATE TABLE IF NOT EXISTS admin_failures (
  event_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, ip)
);
