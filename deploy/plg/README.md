# Fixed PLG source qualification

The Main-owned validate-plg-source.yml and validate-plg-frontend-source.yml
workflows validate the exact sources recorded in production-source.json and
frontend-source.json. Source validation checks immutable content, security,
DCO and tests. It does not grant environment acceptance, production traffic
or customer-delivery authority.

The backend record binds S to the D8 baseline. The frontend record binds W4
to S and preserves the recorded backend. These source records remain useful
for reviewing the PLG-only release independently of unrelated Main changes.

## Retired deployment lane

The separate plg-isolated jobs, target options and setup inputs have been
removed from Deploy to Dev and Deploy to UAT. Do not dispatch the old
plg-isolated-qualification target or create another private qualification lane.

Use the existing standard release workflows and the
[Admin merge and release SOP](../../.agents/skills/repo-operations/references/admin-release-sop.md).
Their actual source approval, CI, schema, capacity, provenance, predecessor
acceptance and rollback requirements remain mandatory. Removing the private
jobs does not make an older source eligible for standard promotion.

Legacy qualification helpers and typed receipts remain for bounded inspection,
capacity accounting and reconciliation of already-created resources. They
cannot substitute for ordinary exact-source Dev or UAT acceptance. No former
isolated receipt authorizes production traffic.

See [retirement boundaries](../../docs/reference/operations/plg-isolated-qualification.md)
before changing retained resources. Preserve customer information and unrelated
shared services; never reset a shared database to fit an older source.
