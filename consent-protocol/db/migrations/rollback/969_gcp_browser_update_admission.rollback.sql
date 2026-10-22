-- Browser approvals bind owner/key/placement to a durable update operation.
-- Preserve their admission and notification recovery predicate. Use forward
-- recovery or disable new offers; SQL rollback cannot undo a cloud replacement.
DO $$ BEGIN
 RAISE EXCEPTION 'GCP Browser update admission requires forward recovery; disable new Browser offers without deleting retained approvals';
END $$;
