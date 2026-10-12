BEGIN;
DROP TRIGGER IF EXISTS direct_message_push_queued ON messages;
DROP FUNCTION IF EXISTS queue_direct_message_push();
DROP TABLE IF EXISTS direct_message_push_outbox;
DROP TABLE IF EXISTS chat_push_device_deliveries;
ALTER TABLE circle_chat_messages DROP COLUMN IF EXISTS notification_previews;
-- Retain the installation registry, compatible legacy ownership bridge and
-- preview public keys. Old handlers retain UNIQUE(user_id, platform), and the
-- bridge revokes transferred registrations even after a backend rollback.
ALTER TABLE circle_chat_recipients ALTER COLUMN push_due_at SET DEFAULT now() + interval '5 seconds';
COMMIT;
