-- Settled legacy generations are immutable history; application rollback keeps
-- this guard. Turn generation admission off as the incident stop and use a
-- reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'legacy generation settlement requires forward recovery; settled generations are immutable history' USING ERRCODE='55000';
END $$;
