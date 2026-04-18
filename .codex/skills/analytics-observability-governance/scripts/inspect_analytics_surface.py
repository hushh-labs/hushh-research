#!/usr/bin/env python3
"""Non-mutating inspection helper for Kai analytics observability surfaces."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account


DEFAULTS = {
    "prod_property": "526603671",
    "uat_property": "533362555",
    "prod_project": "hushh-pda",
    "uat_project": "hushh-pda-uat",
    "secret_project": "hushh-pda",
    "secret_name": "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "prod_excluded_streams": ["13702689760"],
    "required_key_events": [
        "investor_activation_completed",
        "ria_activation_completed",
    ],
    "required_custom_dimensions": [
        "journey",
        "step",
        "entry_surface",
        "auth_method",
        "portfolio_source",
        "workspace_source",
        "env",
        "platform",
        "app_version",
    ],
}


def run_json_command(cmd: list[str]) -> object:
    return json.loads(subprocess.check_output(cmd, text=True))


def load_service_account_json(args: argparse.Namespace) -> str:
    if args.service_account_json:
        return Path(args.service_account_json).read_text(encoding="utf-8")

    env_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if env_path and Path(env_path).exists():
        return Path(env_path).read_text(encoding="utf-8")

    secret_names = [args.secret_name]
    if "FIREBASE_ADMIN_CREDENTIALS_JSON" not in secret_names:
        secret_names.append("FIREBASE_ADMIN_CREDENTIALS_JSON")

    last_error: subprocess.CalledProcessError | None = None
    for secret_name in secret_names:
        try:
            return subprocess.check_output(
                [
                    "gcloud",
                    "secrets",
                    "versions",
                    "access",
                    "latest",
                    f"--secret={secret_name}",
                    f"--project={args.secret_project}",
                ],
                text=True,
            )
        except subprocess.CalledProcessError as error:
            last_error = error

    if last_error is not None:
        raise last_error
    raise RuntimeError("unable to load analytics service account secret")


def build_session(args: argparse.Namespace) -> AuthorizedSession:
    payload = load_service_account_json(args)
    with tempfile.NamedTemporaryFile("w", delete=False) as handle:
        handle.write(payload)
        temp_path = handle.name
    try:
        creds = service_account.Credentials.from_service_account_file(
            temp_path,
            scopes=["https://www.googleapis.com/auth/analytics.readonly"],
        )
    finally:
        os.unlink(temp_path)
    return AuthorizedSession(creds)


def ga_get(session: AuthorizedSession, path: str, version: str = "v1beta") -> object:
    url = f"https://analyticsadmin.googleapis.com/{version}/{path.lstrip('/')}"
    response = session.get(url)
    response.raise_for_status()
    return response.json()


def list_bq_datasets(project_id: str) -> list[dict]:
    datasets = run_json_command(["bq", "ls", "-a", "--format=json", f"--project_id={project_id}"])
    return datasets if isinstance(datasets, list) else []


def list_bq_tables(project_id: str, dataset_id: str) -> list[dict]:
    try:
        tables = run_json_command(
            ["bq", "ls", "--format=json", f"{project_id}:{dataset_id}"]
        )
    except subprocess.CalledProcessError:
        return []
    return tables if isinstance(tables, list) else []


def inspect_property(
    session: AuthorizedSession,
    property_id: str,
    project_id: str,
) -> dict:
    streams = ga_get(session, f"properties/{property_id}/dataStreams", version="v1beta").get(
        "dataStreams", []
    )
    key_events = ga_get(
        session, f"properties/{property_id}/conversionEvents", version="v1beta"
    ).get("conversionEvents", [])
    custom_dimensions = ga_get(
        session, f"properties/{property_id}/customDimensions", version="v1beta"
    ).get("customDimensions", [])
    bigquery_links = ga_get(
        session, f"properties/{property_id}/bigQueryLinks", version="v1alpha"
    ).get("bigqueryLinks", [])
    datasets = list_bq_datasets(project_id)
    dataset_ids = [entry["datasetReference"]["datasetId"] for entry in datasets]
    export_dataset = f"analytics_{property_id}"
    tables = list_bq_tables(project_id, export_dataset) if export_dataset in dataset_ids else []

    return {
        "property_id": property_id,
        "project_id": project_id,
        "streams": streams,
        "key_events": key_events,
        "custom_dimensions": custom_dimensions,
        "bigquery_links": bigquery_links,
        "datasets": dataset_ids,
        "export_dataset": export_dataset,
        "export_tables": [entry.get("tableReference", {}).get("tableId") for entry in tables],
    }


def build_summary(args: argparse.Namespace) -> dict:
    session = build_session(args)
    return {
        "production": inspect_property(session, args.prod_property, args.prod_project),
        "uat": inspect_property(session, args.uat_property, args.uat_project),
    }


def validate(summary: dict) -> dict:
    findings: dict[str, list[str]] = {"high": [], "medium": [], "low": []}

    for label, payload in summary.items():
        stream_ids = {entry["name"].split("/")[-1] for entry in payload["streams"]}
        types = {entry["type"] for entry in payload["streams"]}
        key_event_names = {entry["eventName"] for entry in payload["key_events"]}
        custom_dimension_names = {entry["parameterName"] for entry in payload["custom_dimensions"]}

        if "WEB_DATA_STREAM" not in types or "IOS_APP_DATA_STREAM" not in types or "ANDROID_APP_DATA_STREAM" not in types:
            findings["high"].append(f"{label}: missing one or more primary stream types")

        for event_name in DEFAULTS["required_key_events"]:
            if event_name not in key_event_names:
                findings["high"].append(f"{label}: missing key event {event_name}")

        for parameter_name in DEFAULTS["required_custom_dimensions"]:
            if parameter_name not in custom_dimension_names:
                findings["high"].append(f"{label}: missing custom dimension {parameter_name}")

        if not payload["bigquery_links"]:
            findings["high"].append(f"{label}: missing BigQuery export link")

        export_dataset = payload["export_dataset"]
        if export_dataset not in payload["datasets"]:
            findings["medium"].append(
                f"{label}: expected export dataset {export_dataset} not visible yet"
            )
        elif not payload["export_tables"]:
            findings["medium"].append(
                f"{label}: export dataset {export_dataset} exists but has no visible tables yet"
            )

        if label == "production":
            excluded = set(DEFAULTS["prod_excluded_streams"])
            exported_streams = set()
            for link in payload["bigquery_links"]:
                for stream_name in link.get("exportStreams", []):
                    exported_streams.add(stream_name.split("/")[-1])
            leaked = excluded & exported_streams
            if leaked:
                findings["high"].append(
                    f"production: excluded stream(s) still present in export link: {sorted(leaked)}"
                )

        if not stream_ids:
            findings["high"].append(f"{label}: property returned no streams")

    ok = not findings["high"]
    return {"ok": ok, "findings": findings}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect Kai analytics observability surfaces")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("summary", "validate"):
        command = sub.add_parser(name)
        command.add_argument("--service-account-json")
        command.add_argument("--secret-project", default=DEFAULTS["secret_project"])
        command.add_argument("--secret-name", default=DEFAULTS["secret_name"])
        command.add_argument("--prod-property", default=DEFAULTS["prod_property"])
        command.add_argument("--uat-property", default=DEFAULTS["uat_property"])
        command.add_argument("--prod-project", default=DEFAULTS["prod_project"])
        command.add_argument("--uat-project", default=DEFAULTS["uat_project"])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = build_summary(args)
    if args.cmd == "summary":
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0
    result = validate(summary)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
