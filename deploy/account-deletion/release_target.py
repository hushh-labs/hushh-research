"""Canonical environment-local targets for the account-deletion activation CLI."""

import argparse
import re
from urllib.parse import urlparse


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "project",
        "region",
        "backend-service",
        "backend-url",
        "oidc-audience",
        "scheduler-job",
        "scheduler-service-account",
        "expected-sha",
        "expected-run-id",
        "cloudsql-instance",
        "evidence-prefix",
    ]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--production-restoration", action="store_true")
    parser.add_argument("--db-name", default="postgres")
    parser.add_argument("--db-port", type=int, default=6543)
    parser.add_argument("--fence-required", choices=["true", "false"], required=True)
    args = parser.parse_args()
    validate_arguments(parser, args)
    args.fence_required = args.fence_required == "true"
    return args


def validate_arguments(parser, args):
    for name in [
        "project",
        "region",
        "backend_service",
        "scheduler_job",
        "scheduler_service_account",
        "db_name",
    ]:
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", getattr(args, name)):
            parser.error("invalid release identifier")
    if (
        not re.fullmatch(r"[0-9a-f]{40}", args.expected_sha)
        or not args.expected_run_id.isdigit()
    ):
        parser.error("exact release identity required")
    if not re.fullmatch(r"[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+", args.cloudsql_instance):
        parser.error("exact Cloud SQL instance required")
    if not 1024 <= args.db_port <= 65535:
        parser.error("invalid owned proxy port")
    for url in [args.backend_url, args.oidc_audience]:
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            parser.error("HTTPS release origins required")
    targets = {
        "hushh-pda-dev": (
            "hushh-pda-dev:us-central1:hushh-dev-pg",
            "https://consent-protocol-621416509462.us-central1.run.app",
            "postgres",
        ),
        "hushh-pda-uat": (
            "hushh-pda-uat:us-central1:hushh-uat-pg",
            "https://api.uat.hushh.ai",
            "postgres",
        ),
        "hushh-pda": (
            "hushh-pda:us-central1:hushh-vault-db",
            "https://api.hushh.ai",
            "hushh_vault",
        ),
    }
    if (
        targets.get(args.project)
        != (args.cloudsql_instance, args.backend_url.rstrip("/"), args.db_name)
        or args.backend_service != "consent-protocol"
        or args.region != "us-central1"
        or args.oidc_audience != args.backend_url.rstrip("/")
    ):
        parser.error("canonical environment-local lifecycle target required")
