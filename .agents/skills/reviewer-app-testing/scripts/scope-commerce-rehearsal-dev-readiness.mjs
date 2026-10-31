import { commerceEvidence, validateDevReadinessBinding } from "./scope-commerce-rehearsal-contract.mjs";

const ORIGIN = "https://dev.one.hussh.ai";
/** An explicit operator adapter must execute the unchanged canonical guard freshly.
 * The default rehearsal still requires a complete release ledger. Shared Dev instead
 * uses its declared replay/minimum contract; its API release head remains truthful.
 */
export function verifySharedDevReadiness(value, expected, contract, now = Date.now()) {
  const binding = validateDevReadinessBinding(value?.binding);
  const started = Date.parse(value.startedAt), verified = Date.parse(value.verifiedAt);
  const checked = Date.parse(value.report?.checked_at);
  commerceEvidence(expected.appOrigin === ORIGIN && value.appOrigin === ORIGIN &&
    value.platformAccountId === expected.platformAccountId &&
    typeof value.configurationVersion === "string" && /^[1-9][0-9]*$/.test(value.configurationVersion) &&
    binding.contractSha256 === expected.contractSha256 && binding.checkerSha256 === expected.checkerSha256 &&
    Number.isFinite(started) && started <= checked && checked <= verified && verified <= now && now - started <= 300_000,
  "SHARED_DEV_READINESS_FRESH_BINDING_REQUIRED");
  const report = value.report;
  commerceEvidence(contract.contract_name === "dev_minimum_schema" && contract.migration_version_policy === "minimum" &&
    contract.expected_migration_version === expected.schemaHead &&
    report.status === "ok" && report.policy?.skip_db_check === false &&
    report.policy.migration_version_policy === "minimum" &&
    report.migrations?.expected_contract_version === expected.schemaHead &&
    Array.isArray(report.violations) && report.violations.length === 0,
  "SHARED_DEV_CANONICAL_SCHEMA_CHECK_REQUIRED");
  const tables = report.db_contract?.tables, functions = report.db_contract?.functions;
  commerceEvidence(tables && functions && Object.keys(contract.required_tables).length > 0 &&
    contract.required_functions.length > 0 &&
    Object.keys(contract.required_tables).every(name => tables[name]?.exists === true &&
      Array.isArray(tables[name].missing_columns) && tables[name].missing_columns.length === 0) &&
    contract.required_functions.every(name => functions[name] === true), "SHARED_DEV_SCHEMA_RESULTS_INCOMPLETE");
  return Object.freeze({ ...binding });
}
