#!/usr/bin/env python3
"""Compare the production deploy identity against the record that declares it.

WHY THIS EXISTS

`deploy/iam/setup_production_github_wif.sh` is the authoritative record of who may
mint a production deploy token: the attribute mapping (line 17), the attribute
condition (line 18), and the project roles the deploy service account carries
(the `DEPLOY_PROJECT_ROLES` array). It is in version control, reviewed, and
restricted to the maintainer cohort.

What did not exist was a **comparison** of that record against reality. The
`repo-operations` skill instructs an operator to re-run the setup script "when
production GitHub WIF configuration is absent or drifted" -- a remediation for a
condition nothing could detect. Grepping `scripts/` and `.github/` for
`attributeCondition` returned only the setup script itself. This closes that gap
(CM-3 / CM-6) on the most consequential setting the platform owns.

THE ONE RULE THIS FILE FOLLOWS

**The expectations are parsed from the script; they are never retyped here.**
A second copy of the condition living in Python would be a second record, free to
drift from the first, and the drift between the two copies would be invisible --
which is the defect this file exists to remove, reintroduced one layer up. So the
shell script is read at run time and its literals are the expectation.

That splits the checks into two honest kinds:

  * **record checks** need no cloud at all. They assert the record stays internally
    coherent -- most importantly that the condition still pins a single branch,
    since dropping that one clause silently lets any ref in the production
    environment mint a production deploy token.
  * **live checks** compare the record to the provider and IAM policy that GCP
    actually has.

A live read that is refused is reported as `deploy_identity_unverifiable`, never as
a pass. The lane's federated identity is scoped to deploying, not to reading IAM,
so "I could not look" is the expected answer in some contexts and must never be
mistaken for "I looked and it was fine".
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_RECORD = "deploy/iam/setup_production_github_wif.sh"
DEFAULT_WORKFLOW = ".github/workflows/deploy-production.yml"

GITHUB_ISSUER = "https://token.actions.githubusercontent.com"

# Roles that hand out the authority to grant authority. None of them can be a
# legitimate deploy role: a deployer that can rewrite IAM can widen the very
# condition this file checks, and the next run would compare the record against a
# reality the deployer authored.
FORBIDDEN_DEPLOY_ROLES = frozenset(
    {
        "roles/owner",
        "roles/editor",
        "roles/iam.securityAdmin",
        "roles/iam.serviceAccountKeyAdmin",
        "roles/resourcemanager.projectIamAdmin",
    }
)

_SCALAR = re.compile(r"^readonly\s+([A-Za-z_][A-Za-z0-9_]*)=\"?([^\"\n]*)\"?\s*$")
_ARRAY_OPEN = re.compile(r"^readonly\s+-a\s+([A-Za-z_][A-Za-z0-9_]*)=\(\s*$")
_INTERPOLATION = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class RecordError(RuntimeError):
    """The record could not be read. Never downgraded to a passing check."""


# -- reading the record ----------------------------------------------------------------


def parse_record(text: str) -> dict[str, Any]:
    """Extract the declared literals from the setup script.

    Deliberately a narrow reader, not a shell parser: it understands the two forms
    the record actually uses (`readonly NAME="v"` and `readonly -a NAME=( ... )`)
    and resolves `${OTHER}` against values already seen. A form it does not
    understand is skipped rather than guessed at, and the callers below fail loudly
    on a missing key -- so a rewrite of the script surfaces as "the record no longer
    declares X", which is true, rather than as a silently empty expectation.
    """
    values: dict[str, Any] = {}
    array_name: str | None = None
    array_items: list[str] = []

    for raw in text.splitlines():
        line = raw.strip()
        if array_name is not None:
            if line.startswith(")"):
                values[array_name] = array_items
                array_name, array_items = None, []
            elif line and not line.startswith("#"):
                array_items.append(_expand(line.strip().strip('"'), values))
            continue

        opened = _ARRAY_OPEN.match(line)
        if opened:
            array_name, array_items = opened.group(1), []
            continue

        scalar = _SCALAR.match(line)
        if scalar:
            values[scalar.group(1)] = _expand(scalar.group(2), values)

    return values


def _expand(value: str, seen: dict[str, Any]) -> str:
    """Resolve `${NAME}` against values already parsed.

    The record defines every name before it is used, so one forward pass is
    sufficient. An unresolved reference is left verbatim -- it then fails an
    equality check against live GCP with the literal `${...}` visible in the
    report, which names the problem better than an empty string would.
    """
    return _INTERPOLATION.sub(lambda match: str(seen.get(match.group(1), match.group(0))), value)


def load_record(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise RecordError(f"the deploy identity record is missing: {path}")
    record = parse_record(path.read_text(encoding="utf-8"))
    required = (
        "PROD_PROJECT_ID",
        "GITHUB_REPOSITORY",
        "GITHUB_ENVIRONMENT",
        "POOL_ID",
        "PROVIDER_ID",
        "DEPLOY_SERVICE_ACCOUNT_EMAIL",
        "ATTRIBUTE_MAPPING",
        "ATTRIBUTE_CONDITION",
        "DEPLOY_PROJECT_ROLES",
    )
    missing = [key for key in required if not record.get(key)]
    if missing:
        raise RecordError(f"{path} no longer declares: {', '.join(missing)}")
    return record


def mapping_pairs(mapping: str) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for chunk in mapping.split(","):
        key, _, value = chunk.partition("=")
        if key.strip():
            pairs[key.strip()] = value.strip()
    return pairs


# -- checks that need no cloud ---------------------------------------------------------


def audit_record(record: dict[str, Any], workflow_text: str | None) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    condition = str(record["ATTRIBUTE_CONDITION"])
    mapping = mapping_pairs(str(record["ATTRIBUTE_MAPPING"]))

    # The highest-consequence clause in the whole file. Without it, the condition
    # still names the repository and environment -- so it reads as tight -- while
    # accepting a token minted from any ref, including a branch opened minutes ago.
    if "assertion.ref ==" not in condition:
        failures.append(
            {
                "reason": "condition_does_not_pin_a_ref",
                "condition": condition,
                "detail": (
                    "the production attribute condition no longer pins assertion.ref. "
                    "Any ref running in the production environment could mint a "
                    "production deploy token."
                ),
            }
        )

    expected_subject = (
        f"repo:{record['GITHUB_REPOSITORY']}:environment:{record['GITHUB_ENVIRONMENT']}"
    )
    # Matched as a quoted equality, not as a substring. A bare `in` test accepts any
    # subject the expected one is a prefix of -- `environment:prod` would "match" a
    # condition pinning `environment:production`, and a renamed environment would
    # sail through the one check meant to catch it.
    subject_equality = re.compile(rf"assertion\.sub\s*==\s*'{re.escape(expected_subject)}'")
    if not subject_equality.search(condition):
        failures.append(
            {
                "reason": "condition_subject_disagrees_with_record",
                "expected_subject": expected_subject,
                "condition": condition,
                "detail": (
                    "the condition's subject no longer matches the repository and "
                    "environment this record configures, so it would refuse the token "
                    "the lane actually presents."
                ),
            }
        )

    # The workloadIdentityUser binding is a principalSet on attribute.repository.
    # A mapping that stops emitting that attribute makes the binding match nothing.
    if "attribute.repository" not in mapping:
        failures.append(
            {
                "reason": "mapping_drops_an_attribute_the_binding_consumes",
                "attribute": "attribute.repository",
                "mapping": mapping,
                "detail": (
                    "the workloadIdentityUser member is a principalSet on "
                    "attribute.repository; without that mapping no principal matches."
                ),
            }
        )

    roles = list(record["DEPLOY_PROJECT_ROLES"])
    escalating = sorted(set(roles) & FORBIDDEN_DEPLOY_ROLES)
    if escalating:
        failures.append(
            {
                "reason": "deploy_role_can_grant_authority",
                "roles": escalating,
                "detail": (
                    "a deployer holding these roles can rewrite the condition that "
                    "constrains it, which makes every check below self-attested."
                ),
            }
        )

    if workflow_text is not None:
        declared = sorted(
            set(re.findall(r"^\s*environment:\s*([A-Za-z0-9_.-]+)\s*$", workflow_text, re.M))
        )
        environment = str(record["GITHUB_ENVIRONMENT"])
        if declared and environment not in declared:
            failures.append(
                {
                    "reason": "workflow_environment_disagrees_with_record",
                    "record": environment,
                    "workflow": declared,
                    "detail": (
                        "the condition pins an environment the production workflow does "
                        "not request, so every production deploy would be refused at "
                        "token exchange with an error that names neither file."
                    ),
                }
            )

    return failures


# -- checks against live GCP -----------------------------------------------------------


def audit_provider(record: dict[str, Any], provider: dict[str, Any]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []

    live_condition = str(provider.get("attributeCondition") or "")
    if live_condition != str(record["ATTRIBUTE_CONDITION"]):
        failures.append(
            {
                "reason": "provider_condition_drift",
                "expected": record["ATTRIBUTE_CONDITION"],
                "actual": live_condition,
            }
        )

    live_mapping = provider.get("attributeMapping") or {}
    if dict(live_mapping) != mapping_pairs(str(record["ATTRIBUTE_MAPPING"])):
        failures.append(
            {
                "reason": "provider_mapping_drift",
                "expected": mapping_pairs(str(record["ATTRIBUTE_MAPPING"])),
                "actual": dict(live_mapping),
            }
        )

    issuer = str(((provider.get("oidc") or {}).get("issuerUri")) or "")
    if issuer != GITHUB_ISSUER:
        failures.append(
            {"reason": "provider_issuer_drift", "expected": GITHUB_ISSUER, "actual": issuer}
        )

    state = str(provider.get("state") or "ACTIVE")
    if state != "ACTIVE" or provider.get("disabled"):
        failures.append(
            {
                "reason": "provider_not_active",
                "state": state,
                "disabled": bool(provider.get("disabled")),
            }
        )

    return failures


def audit_project_bindings(record: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    """Both directions matter.

    A missing role breaks the deploy and is discovered within minutes. An *extra*
    role is privilege creep: it never breaks anything, so nothing surfaces it, and
    the deploy identity quietly accumulates authority no reviewed record grants.
    """
    member = f"serviceAccount:{record['DEPLOY_SERVICE_ACCOUNT_EMAIL']}"
    live = {
        str(binding.get("role") or "")
        for binding in (policy.get("bindings") or [])
        if isinstance(binding, dict) and member in (binding.get("members") or [])
    }
    expected = set(record["DEPLOY_PROJECT_ROLES"])

    failures: list[dict[str, Any]] = []
    if missing := sorted(expected - live):
        failures.append({"reason": "deploy_role_missing", "roles": missing})
    if extra := sorted(live - expected):
        failures.append(
            {
                "reason": "deploy_role_granted_outside_the_record",
                "roles": extra,
                "detail": (
                    "these roles are bound to the deploy service account but no "
                    "reviewed record grants them."
                ),
            }
        )
    return failures


def _gcloud_json(args: list[str]) -> Any:
    result = subprocess.run(  # noqa: S603 - fixed gcloud executable with structured args.
        ["gcloud", *args, "--format=json"],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def _read_live(record: dict[str, Any], args: argparse.Namespace) -> tuple[Any, Any]:
    provider = (
        json.loads(Path(args.provider_json).read_text(encoding="utf-8"))
        if args.provider_json
        else _gcloud_json(
            [
                "iam",
                "workload-identity-pools",
                "providers",
                "describe",
                str(record["PROVIDER_ID"]),
                f"--project={record['PROD_PROJECT_ID']}",
                "--location=global",
                f"--workload-identity-pool={record['POOL_ID']}",
            ]
        )
    )
    policy = (
        json.loads(Path(args.iam_policy_json).read_text(encoding="utf-8"))
        if args.iam_policy_json
        else _gcloud_json(["projects", "get-iam-policy", str(record["PROD_PROJECT_ID"])])
    )
    return provider, policy


def verify(args: argparse.Namespace) -> dict[str, Any]:
    record = load_record(Path(args.record))
    workflow_path = Path(args.workflow)
    workflow_text = workflow_path.read_text(encoding="utf-8") if workflow_path.is_file() else None

    failures = audit_record(record, workflow_text)
    live_checked = False
    unverifiable: dict[str, Any] | None = None

    if not args.record_only:
        try:
            provider, policy = _read_live(record, args)
        except (subprocess.CalledProcessError, OSError, ValueError) as error:
            detail = getattr(error, "stderr", None) or str(error)
            unverifiable = {
                "reason": "live_read_refused",
                "detail": str(detail).strip()[:400],
            }
        else:
            live_checked = True
            failures.extend(audit_provider(record, provider))
            failures.extend(audit_project_bindings(record, policy))

    classifications: list[str] = []
    if failures:
        classifications.append("deploy_authority_drift")
    if unverifiable:
        classifications.append("deploy_identity_unverifiable")

    return {
        "record": str(args.record),
        "project": record["PROD_PROJECT_ID"],
        "provider": f"{record['POOL_ID']}/{record['PROVIDER_ID']}",
        "deploy_service_account": record["DEPLOY_SERVICE_ACCOUNT_EMAIL"],
        "record_checked": True,
        "live_checked": live_checked,
        "status": "healthy" if not failures and not unverifiable else "blocked",
        # A refused read is not a pass. `ok` stays false so a lane that gates on the
        # exit code cannot mistake "could not look" for "looked and it was fine".
        "ok": not failures and not unverifiable,
        "classifications": classifications,
        "expected": {
            "attributeCondition": record["ATTRIBUTE_CONDITION"],
            "attributeMapping": mapping_pairs(str(record["ATTRIBUTE_MAPPING"])),
            "projectRoles": sorted(record["DEPLOY_PROJECT_ROLES"]),
        },
        "unverifiable": unverifiable,
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", default=DEFAULT_RECORD)
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW)
    parser.add_argument(
        "--record-only",
        action="store_true",
        help="run only the checks that need no cloud access",
    )
    parser.add_argument("--provider-json", default="")
    parser.add_argument("--iam-policy-json", default="")
    parser.add_argument("--report-path", default="")
    args = parser.parse_args(argv)

    report = verify(args)
    if args.report_path:
        path = Path(args.report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
