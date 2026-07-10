#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""End-to-end dev-environment doctor: audits the hosted dev GCP project against UAT.

The baseline is derived LIVE from the UAT project (enabled APIs, secret names,
Cloud SQL shape and users, runtime service-account roles, Cloud Run services,
scheduler jobs), so the audit stays correct as UAT evolves. Dev-specific
expectations (override secrets, runtime identity, Pub/Sub fanout, domain
mapping) are asserted explicitly.

Each failed check prints a remediation command. Exit codes: 0 = healthy,
1 = failures present. Warnings never fail the run.

Usage:
  python3 scripts/ops/dev_environment_doctor.py \
    --dev-project hushh-pda-dev --uat-project hushh-pda-uat \
    [--region us-central1] [--report-path /tmp/dev-doctor.json]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from typing import Any

CHECKS: list[dict[str, Any]] = []

# Secrets whose values MUST differ from UAT in dev (environment-specific).
OVERRIDE_SECRETS = ("APP_FRONTEND_ORIGIN", "BACKEND_URL", "DB_PASSWORD")

# APIs dev needs beyond whatever UAT reports (UAT may predate the API split).
REQUIRED_DEV_APIS = (
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "aiplatform.googleapis.com",
)

RUNTIME_SA_KINDS = {
    "compute": "-compute@developer.gserviceaccount.com",
    "cloudbuild": "@cloudbuild.gserviceaccount.com",
}

FANOUT_SUBSCRIPTION = "one-email-kyc-dev-push"
FANOUT_TOPIC_PROJECT = "hushh-pda"
FANOUT_TOPIC = "one-email-kyc-uat"

DEV_DOMAIN = "dev.kai.hushh.ai"
BACKEND_SERVICE = "consent-protocol"
FRONTEND_SERVICE = "hushh-webapp"
DEV_SQL_INSTANCE = "hushh-dev-pg"
UAT_SQL_INSTANCE = "hushh-uat-pg"


def run(args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc.returncode, proc.stdout.strip()


def gcloud_json(args: list[str]) -> Any:
    code, out = run(["gcloud", *args, "--format=json"])
    if code != 0:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def record(name: str, status: str, detail: str, fix: str = "") -> None:
    CHECKS.append({"check": name, "status": status, "detail": detail, "fix": fix})
    symbol = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[status]
    print(f"[{symbol}] {name}: {detail}")
    if fix and status != "pass":
        print(f"       fix: {fix}")


def check_project(dev: str, uat: str) -> str | None:
    dev_info = gcloud_json(["projects", "describe", dev])
    uat_info = gcloud_json(["projects", "describe", uat])
    if not dev_info:
        record("project", "fail", f"{dev} is not accessible",
               f"gcloud projects create {dev} --folder=<uat-folder>")
        return None
    if dev_info.get("lifecycleState") != "ACTIVE":
        record("project", "fail", f"{dev} lifecycleState={dev_info.get('lifecycleState')}")
        return None
    detail = f"{dev} ACTIVE (name: {dev_info.get('name')})"
    if uat_info and dev_info.get("parent") != uat_info.get("parent"):
        record("project", "warn", detail + "; parent folder differs from UAT")
    else:
        record("project", "pass", detail)

    dev_billing = gcloud_json(["billing", "projects", "describe", dev])
    uat_billing = gcloud_json(["billing", "projects", "describe", uat])
    if not dev_billing or not dev_billing.get("billingEnabled"):
        record("billing", "fail", f"billing disabled on {dev}",
               f"gcloud billing projects link {dev} --billing-account=<account>")
    elif uat_billing and dev_billing.get("billingAccountName") != uat_billing.get("billingAccountName"):
        record("billing", "warn",
               f"dev bills to {dev_billing.get('billingAccountName')}, UAT to {uat_billing.get('billingAccountName')}")
    else:
        record("billing", "pass", f"billing enabled ({dev_billing.get('billingAccountName')})")
    return str(dev_info.get("projectNumber"))


def check_apis(dev: str, uat: str) -> None:
    dev_apis = {s["config"]["name"] for s in gcloud_json(["services", "list", "--enabled", f"--project={dev}"]) or []}
    uat_apis = {s["config"]["name"] for s in gcloud_json(["services", "list", "--enabled", f"--project={uat}"]) or []}
    if not dev_apis:
        record("apis", "fail", f"could not list enabled services on {dev}")
        return
    required = set(REQUIRED_DEV_APIS) | uat_apis
    missing = sorted(required - dev_apis)
    if missing:
        record("apis", "fail", f"missing {len(missing)} API(s): {', '.join(missing)}",
               f"gcloud services enable {' '.join(missing)} --project={dev}")
    else:
        record("apis", "pass", f"{len(dev_apis)} APIs enabled; covers UAT set + dev requirements")


def check_secrets(dev: str, uat: str) -> None:
    dev_names = {s["name"].split("/")[-1] for s in gcloud_json(["secrets", "list", f"--project={dev}"]) or []}
    uat_names = {s["name"].split("/")[-1] for s in gcloud_json(["secrets", "list", f"--project={uat}"]) or []}
    if not uat_names:
        record("secrets", "fail", f"could not list UAT secrets in {uat}")
        return
    missing = sorted(uat_names - dev_names)
    if missing:
        record("secrets", "fail", f"{len(missing)} UAT secret(s) missing in dev: {', '.join(missing[:10])}",
               "replicate via consent-protocol/docs/reference/dev-environment-setup.md Phase 3")
    else:
        record("secrets", "pass", f"all {len(uat_names)} UAT secret names present in dev")

    def secret_value(project: str, name: str) -> str | None:
        code, out = run(["gcloud", "secrets", "versions", "access", "latest",
                         f"--secret={name}", f"--project={project}"])
        return out if code == 0 else None

    for name in OVERRIDE_SECRETS:
        dev_val, uat_val = secret_value(dev, name), secret_value(uat, name)
        if dev_val is None:
            record(f"secret-override:{name}", "fail", "missing in dev",
                   f"gcloud secrets create {name} --project={dev} && add a dev-specific version")
        elif uat_val is not None and dev_val == uat_val:
            record(f"secret-override:{name}", "fail", "dev value equals UAT value (must be dev-specific)",
                   f"add a dev-specific version: gcloud secrets versions add {name} --project={dev}")
        else:
            record(f"secret-override:{name}", "pass", "present and differs from UAT")

    runtime_cfg = secret_value(dev, "BACKEND_RUNTIME_CONFIG_JSON")
    if runtime_cfg:
        try:
            cfg = json.loads(runtime_cfg)
        except json.JSONDecodeError:
            cfg = {}
        socket = str(cfg.get("db_unix_socket") or cfg.get("cloudsql_instance_connection_name") or "")
        if dev.split("-")[0] not in socket and DEV_SQL_INSTANCE not in socket:
            record("runtime-config-db", "fail",
                   f"BACKEND_RUNTIME_CONFIG_JSON does not reference the dev Cloud SQL instance ({socket or 'unset'})",
                   "re-run scripts/ops/sync_backend_runtime_secrets.py with dev parameters")
        else:
            record("runtime-config-db", "pass", "runtime config points at the dev Cloud SQL instance")
        rp_ids = str(cfg.get("passkey_allowed_rp_ids", ""))
        env_identity = str(cfg.get("environment", ""))
        if env_identity != "uat":
            record("runtime-identity", "fail",
                   f"runtime config environment={env_identity!r}; dev must keep the uat runtime identity",
                   "re-run sync_backend_runtime_secrets.py with --environment uat")
        else:
            record("runtime-identity", "pass", "runtime identity is uat (behavior parity by design)")
        if DEV_DOMAIN not in rp_ids:
            record("runtime-config-passkeys", "warn",
                   f"passkey RP ids do not include {DEV_DOMAIN} ({rp_ids or 'unset'})")
        else:
            record("runtime-config-passkeys", "pass", f"passkey RP ids include {DEV_DOMAIN}")


def check_sql(dev: str, uat: str) -> None:
    dev_inst = gcloud_json(["sql", "instances", "describe", DEV_SQL_INSTANCE, f"--project={dev}"])
    uat_inst = gcloud_json(["sql", "instances", "describe", UAT_SQL_INSTANCE, f"--project={uat}"])
    if not dev_inst:
        record("cloudsql-instance", "fail", f"{DEV_SQL_INSTANCE} not found in {dev}",
               f"gcloud sql instances create {DEV_SQL_INSTANCE} --project={dev} "
               "--region=us-central1 --database-version=<uat-version> --tier=<uat-tier>")
        return
    state = dev_inst.get("state")
    if state != "RUNNABLE":
        record("cloudsql-instance", "fail", f"{DEV_SQL_INSTANCE} state={state}")
        return
    detail = f"{DEV_SQL_INSTANCE} RUNNABLE ({dev_inst.get('databaseVersion')}, {dev_inst['settings'].get('tier')})"
    if uat_inst and (dev_inst.get("databaseVersion") != uat_inst.get("databaseVersion")
                     or dev_inst["settings"].get("tier") != uat_inst["settings"].get("tier")):
        record("cloudsql-instance", "warn", detail + "; version/tier differs from UAT")
    else:
        record("cloudsql-instance", "pass", detail)

    dev_users = {u["name"] for u in gcloud_json(
        ["sql", "users", "list", f"--instance={DEV_SQL_INSTANCE}", f"--project={dev}"]) or []}
    code, uat_app_user = run(["gcloud", "secrets", "versions", "access", "latest",
                              "--secret=DB_USER", f"--project={dev}"])
    required_users = {u for u in (uat_app_user if code == 0 else "", "mulesoft_crm_registry") if u}
    missing_users = sorted(required_users - dev_users)
    if missing_users:
        record("cloudsql-users", "fail", f"missing DB user(s): {', '.join(missing_users)}",
               f"gcloud sql users create <user> --instance={DEV_SQL_INSTANCE} --project={dev} --password=<generated>")
    else:
        record("cloudsql-users", "pass", f"required DB users present ({', '.join(sorted(required_users))})")


def check_runtime_sa_iam(dev: str, uat: str, dev_number: str | None) -> None:
    if not dev_number:
        record("iam-runtime-sas", "warn", "skipped (dev project number unknown)")
        return
    uat_number = None
    uat_info = gcloud_json(["projects", "describe", uat])
    if uat_info:
        uat_number = str(uat_info.get("projectNumber"))

    def roles_for(project: str, member_suffix: str) -> set[str]:
        policy = gcloud_json(["projects", "get-iam-policy", project])
        roles: set[str] = set()
        for binding in (policy or {}).get("bindings", []):
            for member in binding.get("members", []):
                if member.endswith(member_suffix):
                    roles.add(binding["role"])
        return roles

    for kind, suffix in RUNTIME_SA_KINDS.items():
        uat_roles = roles_for(uat, f"{uat_number}{suffix}") if uat_number else set()
        dev_roles = roles_for(dev, f"{dev_number}{suffix}")
        missing = sorted(uat_roles - dev_roles)
        if missing:
            member = f"serviceAccount:{dev_number}{suffix}"
            fixes = " && ".join(
                f"gcloud projects add-iam-policy-binding {dev} --member='{member}' --role='{r}'" for r in missing)
            record(f"iam-{kind}-sa", "fail", f"missing role(s) vs UAT: {', '.join(missing)}", fixes)
        else:
            record(f"iam-{kind}-sa", "pass", f"role set covers UAT parity ({len(dev_roles)} roles)")


def check_cloud_run(dev: str, region: str) -> dict[str, str]:
    urls: dict[str, str] = {}
    for service in (BACKEND_SERVICE, FRONTEND_SERVICE):
        info = gcloud_json(["run", "services", "describe", service,
                            f"--project={dev}", f"--region={region}"])
        if not info:
            record(f"cloudrun:{service}", "fail", f"service not deployed in {dev}/{region}",
                   "run the Deploy to Dev workflow (or deploy/*.cloudbuild.yaml manually)")
            continue
        url = info.get("status", {}).get("url", "")
        ready = next((c.get("status") for c in info.get("status", {}).get("conditions", [])
                      if c.get("type") == "Ready"), "Unknown")
        labels = info.get("metadata", {}).get("labels", {})
        env_label = labels.get("deploy-env", "")
        urls[service] = url
        if ready != "True":
            record(f"cloudrun:{service}", "fail", f"deployed but not Ready (Ready={ready})")
        elif env_label != "dev":
            record(f"cloudrun:{service}", "warn", f"Ready, but deploy-env label is {env_label!r} (expected dev)")
        else:
            record(f"cloudrun:{service}", "pass", f"Ready at {url} (deploy-env=dev)")
    return urls


def check_health(urls: dict[str, str]) -> None:
    probes = []
    if BACKEND_SERVICE in urls:
        probes.append(("backend-health", f"{urls[BACKEND_SERVICE]}/health"))
    if FRONTEND_SERVICE in urls:
        probes.append(("frontend-health", f"{urls[FRONTEND_SERVICE]}/login"))
    for name, url in probes:
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                status = resp.status
        except Exception as exc:  # noqa: BLE001 - report any probe failure
            record(name, "fail", f"{url} unreachable: {exc}")
            continue
        if 200 <= status < 400:
            record(name, "pass", f"{url} -> {status}")
        else:
            record(name, "fail", f"{url} -> {status}")


def check_pubsub_fanout(dev_number: str | None) -> None:
    sub = gcloud_json(["pubsub", "subscriptions", "describe",
                       f"projects/{FANOUT_TOPIC_PROJECT}/subscriptions/{FANOUT_SUBSCRIPTION}"])
    if not sub:
        record("one-email-fanout", "fail",
               f"subscription {FANOUT_SUBSCRIPTION} missing in {FANOUT_TOPIC_PROJECT}",
               "see runbook Phase 6b (gcloud pubsub subscriptions create ...)")
        return
    topic_ok = sub.get("topic", "").endswith(FANOUT_TOPIC)
    endpoint = sub.get("pushConfig", {}).get("pushEndpoint", "")
    endpoint_ok = dev_number is None or dev_number in endpoint
    if topic_ok and endpoint_ok:
        record("one-email-fanout", "pass", f"{FANOUT_SUBSCRIPTION} on {FANOUT_TOPIC} -> {endpoint}")
    else:
        record("one-email-fanout", "fail",
               f"subscription misconfigured (topic ok: {topic_ok}, endpoint: {endpoint})",
               "recreate per runbook Phase 6b with the dev backend webhook URL")


def check_domain_mapping(dev: str, region: str) -> None:
    mappings = gcloud_json(["beta", "run", "domain-mappings", "list",
                            f"--project={dev}", f"--region={region}"]) or []
    entry = next((m for m in mappings
                  if m.get("metadata", {}).get("name") == DEV_DOMAIN), None)
    if not entry:
        record("domain-mapping", "warn", f"{DEV_DOMAIN} not mapped yet",
               f"gcloud beta run domain-mappings create --service {FRONTEND_SERVICE} "
               f"--domain {DEV_DOMAIN} --region {region} --project {dev}")
        return
    ready = next((c.get("status") for c in entry.get("status", {}).get("conditions", [])
                  if c.get("type") == "Ready"), "Unknown")
    records = entry.get("status", {}).get("resourceRecords", [])
    dns_hint = "; ".join(f"{r.get('name', DEV_DOMAIN)} {r.get('type')} {r.get('rrdata')}" for r in records)
    if ready == "True":
        record("domain-mapping", "pass", f"{DEV_DOMAIN} mapped and Ready")
    else:
        record("domain-mapping", "warn",
               f"{DEV_DOMAIN} mapping exists but not Ready (usually waiting on DNS): {dns_hint}")


def _normalize_job_name(name: str) -> str:
    return name.replace("-uat", "").replace("-dev", "")


def check_schedulers(dev: str, uat: str, region: str) -> None:
    dev_jobs = {_normalize_job_name(j["name"].split("/")[-1]) for j in gcloud_json(
        ["scheduler", "jobs", "list", f"--project={dev}", f"--location={region}"]) or []}
    uat_jobs = {_normalize_job_name(j["name"].split("/")[-1]) for j in gcloud_json(
        ["scheduler", "jobs", "list", f"--project={uat}", f"--location={region}"]) or []}
    # Watch renewal is deliberately UAT-only (single Gmail watch owner).
    expected = {j for j in uat_jobs if "watch" not in j.lower()}
    missing = sorted(expected - dev_jobs)
    if missing:
        record("schedulers", "warn", f"missing scheduler job(s) vs UAT: {', '.join(missing)}",
               "replicate with gcloud scheduler jobs create http ... (see runbook; exclude watch renewal)")
    elif expected:
        record("schedulers", "pass", f"dev has UAT-parity scheduler jobs ({len(expected)})")
    else:
        record("schedulers", "pass", "UAT defines no replicable scheduler jobs in this region")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev-project", default="hushh-pda-dev")
    parser.add_argument("--uat-project", default="hushh-pda-uat")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--report-path", default="")
    args = parser.parse_args()

    print(f"Dev environment doctor: {args.dev_project} vs baseline {args.uat_project}\n")
    dev_number = check_project(args.dev_project, args.uat_project)
    check_apis(args.dev_project, args.uat_project)
    check_secrets(args.dev_project, args.uat_project)
    check_sql(args.dev_project, args.uat_project)
    check_runtime_sa_iam(args.dev_project, args.uat_project, dev_number)
    urls = check_cloud_run(args.dev_project, args.region)
    check_health(urls)
    check_pubsub_fanout(dev_number)
    check_domain_mapping(args.dev_project, args.region)
    check_schedulers(args.dev_project, args.uat_project, args.region)

    fails = [c for c in CHECKS if c["status"] == "fail"]
    warns = [c for c in CHECKS if c["status"] == "warn"]
    summary = {
        "dev_project": args.dev_project,
        "uat_project": args.uat_project,
        "status": "blocked" if fails else ("degraded" if warns else "healthy"),
        "failures": len(fails),
        "warnings": len(warns),
        "checks": CHECKS,
    }
    if args.report_path:
        with open(args.report_path, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
    print(f"\nStatus: {summary['status']} ({len(fails)} failure(s), {len(warns)} warning(s))")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
