# Fixed PLG source qualification

These helpers attach to the existing Main-owned `Deploy to Dev` and `Deploy to
UAT` workflows. Their `plg-isolated-qualification` target never replaces the
shared application or changes production traffic. Default shared deployments
retain their existing admission and mutation locks.

The application is exactly `5de6ee29abe3b00642bd6b745c608279091810b3` (S), recorded
against the serving D8 baseline in `production-source.json`. The genuine
`validate-plg-source.yml` receipt is required; local reports are not admission.
The frontend leaf separately records W2 in `frontend-source.json` and executes
`validate-plg-frontend-source.yml`. Neither source receipt authorizes deployment.

## Isolated Dev, then UAT

After the tooling PR is merged, exact Main smoke passes, and environment setup
is verified, dispatch the existing workflows from Main. Supply actual run IDs:

```sh
gh workflow run deploy-dev.yml --ref main \
  -f target=plg-isolated-qualification -f scope=backend \
  -f sha=5de6ee29abe3b00642bd6b745c608279091810b3 \
  -f plg_source_validation_run=<successful-source-run> \
  -f plg_schema_action=reconcile-bootstrap

gh workflow run deploy-uat.yml --ref main \
  -f target=plg-isolated-qualification -f scope=backend \
  -f sha=5de6ee29abe3b00642bd6b745c608279091810b3 \
  -f plg_source_validation_run=<successful-source-run> \
  -f plg_dev_run=<accepted-isolated-dev-run> \
  -f plg_schema_action=initialize
```

The initial owned Dev namespace has the installed source schema, so its explicit
bootstrap reconciliation must not replay the initializer. Initial UAT requires
an actually empty owned namespace. Later qualification uses `preflight`.
Interrupted or partially initialized schemas require operator reconciliation;
changing the action to `initialize` never resets them. The canonical source
verifier's 120-second limit remains unchanged.

Dev builds the exact Git archive. UAT promotes that accepted executable digest
without rebuilding. Source, cluster identity, schema, Memory index, provider
contract, absence of replacement accounts, runtime roles, global capacity,
allow-policy bindings and private revision provenance are checked. Actual
runtime secret/SQL access and private health are independent of IAM allow-binding
evidence; deny/PAB/group memberships are not inferred from allow policies.

S performs startup DDL. This disposable fixture explicitly permits schema-wide
CREATE to its runtime role and ownership of five startup tables plus genuine
internal dependents. It does not claim a no-DDL runtime. The role has no role
memberships/admin capability or migration-ledger writes; ownership is verified
again after real private startup. Shared/production runtime permissions are not
changed or proven equivalent by this fixture.

Temporary canonical-administrator memberships use a fixed generation-bound
journal in the existing environment Cloud Build bucket before any GRANT. The
next locked execution restores a valid owned interrupted intent before another
admission. Unknown memberships or changed journals refuse automatic adoption.
Journal objects contain no credentials. Normal workflow identity must already
have the required bucket/secret/SQL/deploy access; these helpers do not grant it.

The exact per-attempt artifact is `plg-isolated-acceptance-<env>-<run>-<attempt>`.
`qualification_acceptance.verify()` checks the actual latest successful hosted
attempt, executed steps, producer definitions and artifact digest. Checkpoint
artifacts aid reconciliation; they never grant acceptance. A fresh private
service can have 100% of its own namespace traffic. This is not shared UAT
acceptance or production-promotion authority.

PROD fixed-source promotion and One frontend environment promotion remain
separate release transitions. This change does not dispatch them, publish email
editions, enroll contacts or send messages.
