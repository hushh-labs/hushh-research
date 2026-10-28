-- UAT legacy settlements are immutable generation history. Turn generation
-- admission off as the incident stop and use a reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'UAT legacy generation settlement requires forward recovery; settled generations are immutable history' USING ERRCODE='55000';
END $$;
