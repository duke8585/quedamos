-- The "usual week" mode is gone; every event is a set of dates. The kind column stays (SQLite can't drop a
-- column used in a CHECK) and is always 'dates' from here on.
DELETE FROM versions WHERE event_id IN (SELECT id FROM events WHERE kind = 'week');
DELETE FROM responses WHERE event_id IN (SELECT id FROM events WHERE kind = 'week');
DELETE FROM admin_failures WHERE event_id IN (SELECT id FROM events WHERE kind = 'week');
DELETE FROM events WHERE kind = 'week';
