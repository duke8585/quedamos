-- Optional admin password (PBKDF2 hash) + masked hint (first + last character, real length) shown after 3 wrong tries.
ALTER TABLE events ADD COLUMN admin_password_hash TEXT;
ALTER TABLE events ADD COLUMN admin_password_hint TEXT;
-- Archived events are read-only; archiving needs the admin password.
ALTER TABLE events ADD COLUMN archived_at TEXT;
-- SHA-256 of the per-answer edit token kept in the answering browser. On events with an admin password,
-- changing an answer needs this token or the admin password.
ALTER TABLE responses ADD COLUMN edit_token_hash TEXT;
