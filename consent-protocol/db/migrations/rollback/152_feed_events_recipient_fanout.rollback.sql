BEGIN;

-- Roll back migration 152: stop writing the recipient's copy of a location
-- share Feed row.
--
-- Only the trigger and its function are dropped. Rows already written to
-- recipients are LEFT IN PLACE: they are a true record of shares those people
-- really received, and deleting them would silently remove activity from
-- someone's Feed. They render correctly without the trigger, since the
-- wording is chosen client-side from the row's own `feed_audience` value.
--
-- feed_events_from_one_location_events() (the owner-scoped fan-out) is not
-- touched here — it is a separate function and predates this migration.

DROP TRIGGER IF EXISTS one_location_events_feed_fanout_recipient ON one_location_events;
DROP FUNCTION IF EXISTS feed_events_recipient_from_one_location_events();

COMMIT;
