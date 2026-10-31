-- Code-only rollback. Revert the Finance sharing routes/UI to stop new use.
-- Keep encrypted issued objects, terminal revocations and relationship guards.
-- Dropping these tables would destroy customer confirmations and recovery state.
SELECT 1;
