-- Additive rollback: old runtimes ignore this column. Retain committed receipts
-- so reverting application code cannot turn an uncertain batch into a replay.
SELECT 1;
