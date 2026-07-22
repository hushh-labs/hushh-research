# Schema Migration Discipline (Expand/Contract)

Canonical rules for Postgres schema changes in consent-protocol and any future shared tier. A schema change is the riskiest change we ship because data is the one thing a deploy rollback cannot restore. The failure mode is coupling a schema change to the code change that uses it: during the rollout window old and new code run simultaneously, and one of them queries a shape that no longer exists.

The rule: **never change a column in place.** Migrate in additive phases so old and new code are both valid at every step.

## Visual Map

```
EXPAND ──────────────→ MIGRATE ──────────────→ CONTRACT
add the new shape,     backfill existing rows,  once nothing reads the
nullable, alongside    dual-write old+new from  old shape, drop it in a
the old one            the app                  later, separate deploy

deploy N               deploy N+1 .. N+k        deploy N+k+1 (alone)
reversible             reversible               destructive, evidence-gated
```

Worked example — renaming `name` to `full_name`:

1. **Expand.** Add `full_name` nullable. Deploy. Old code ignores it; nothing breaks.
2. **Dual-write.** App writes both fields on every insert/update. Deploy.
3. **Backfill.** Copy `name → full_name` in throttled batches (a single UPDATE over millions of rows locks the table).
4. **Switch reads.** Point the app at `full_name`, keep writing both. Deploy and bake.
5. **Contract.** Stop writing `name`; then — in a separate, later deploy — drop the column.

Each step is independently deployable and reversible: if step 4 misbehaves, roll the code back and `full_name` is still populated.

## Rules

1. **Additive first, destructive last and alone.** New nullable columns, new tables, and new indexes are safe in any deploy. Drops and renames get their own deploy, after repo evidence shows no code references the old shape.
2. **Every migration has a tested down path.** A migration you cannot reverse is a deploy you cannot roll back. Write and run the `down` before merging; record it in the release migration manifest.
3. **Backfills run off the hot path, in batches, throttled.** Never inside the migration transaction for large tables.
4. **Large indexes build without blocking writes** (`CREATE INDEX CONCURRENTLY`).
5. **Risky cutovers decouple from code by feature flag** so the read-switch can be reverted without a deploy.
6. **Scale-plane seam noted per mechanism** (AGENTS.md doctrine #4): every new Postgres-backed shared-state mechanism documents its Redis/Memorystore upgrade path in code comments or the owning doc — the expand/contract discipline applies to that future swap too.
7. **Applied history is immutable.** Accepted migration IDs, filenames, and
   SHA-256 checksums are ledgered under a Postgres advisory lock. Never edit a
   baselined migration; add a new migration.
8. **Ledger mode requires preservation evidence.** An environment cannot enter
   pending-only execution until a checksummed backup has been restored to an
   isolated clone and the exact/additive zero-loss comparisons have passed.
9. **Runtime credentials do not own schema.** Runtime `ensure_table` calls are
   temporary compatibility assertions only; migrate equivalent DDL into the
   canonical baseline before removing DDL privilege from the runtime role.

## Rationalizations, rebutted

| Rationalization | Reality |
|---|---|
| "Just rename the column, it's one line" | During rollout, old and new code run together; one of them queries a column that no longer exists. Expand/contract, never rename in place. |
| "Add the column and drop the old one in the same migration" | Couples a safe add to a destructive drop. Drops ship alone, after nothing references the old shape. |
| "We'll write the rollback if we need it" | By then the deploy is already stuck. The down path is written and tested before merge, or the migration does not merge. |
| "The table is small today" | Backfill patterns copied from small tables become table locks on big ones. Batch from day one; the pattern is the contract. |

## Red flags

- A schema change and the code depending on it in the same deploy
- A column renamed or dropped in place
- A migration merged with no tested down path
- A backfill inside the migration transaction on a growing table
- A destructive step whose "no remaining readers" claim rests on memory instead of repo evidence
