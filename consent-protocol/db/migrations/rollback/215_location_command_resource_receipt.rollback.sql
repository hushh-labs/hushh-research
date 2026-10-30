BEGIN;
-- Roll application code back independently. Keep additive receipt locators
-- so response-loss recovery never repeats an already committed circle create.
SELECT 1;
COMMIT;
