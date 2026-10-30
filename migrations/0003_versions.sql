-- Version history: a snapshot of all answers after each change. Painting autosaves often, so
-- consecutive saves of the same answer are merged into one version (see addVersion in the worker).
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  kind TEXT NOT NULL, -- baseline | created | added | edited | removed | restored
  subject TEXT, -- person's name, or the restored version number
  response_id TEXT,
  snapshot TEXT NOT NULL, -- JSON array of response rows
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_versions_event ON versions(event_id);

-- Events created before history existed start with their current answers.
INSERT INTO versions (id, event_id, version_number, kind, snapshot, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))), e.id, 1, 'baseline',
  (SELECT json_group_array(json_object(
     'id', r.id, 'name', r.name, 'slots', r.slots, 'edit_token_hash', r.edit_token_hash,
     'created_at', r.created_at, 'updated_at', r.updated_at))
   FROM responses r WHERE r.event_id = e.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM events e;
