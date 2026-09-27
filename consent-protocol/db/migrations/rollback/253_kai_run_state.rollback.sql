-- Roll back code first: the previous backend never reads kai_run_state, and a
-- live run is still served by the process that owns it.
BEGIN;
DROP TABLE IF EXISTS kai_run_state;
COMMIT;
