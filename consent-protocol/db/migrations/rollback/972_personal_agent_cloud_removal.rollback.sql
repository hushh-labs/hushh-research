-- Cloud-removal receipts authorize registry deletion. Never remove their guards
-- or evidence while an admitted or completed operation exists.
DO $$ BEGIN
 RAISE EXCEPTION 'cloud removal requires forward recovery; preserve admitted operations and receipts';
END $$;
