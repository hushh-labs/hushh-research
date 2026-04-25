#!/usr/bin/env python3
"""Inspect and verify Kai analytics observability surfaces."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account


DEFAULTS = {
    "prod_property": "526603671",
    "uat_property": "533362555",
    "prod_project": "hushh-pda",
    "uat_project": "hushh-pda-uat",
    "secret_project": "hushh-pda-uat",
    "secret_name": "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "prod_excluded_streams": ["13702689760"],
    "expected_streams": {
        "production": [
            {
                "stream_id": "13694989021",
                "type": "ANDROID_APP_DATA_STREAM",
                "firebase_app_id": "1:1006304528804:android:e38e29d91ba817aecfd931",
            },
            {
                "stream_id": "13695001361",
                "type": "IOS_APP_DATA_STREAM",
                "firebase_app_id": "1:1006304528804:ios:eb2720b5eda7da4bcfd931",
            },
            {
                "stream_id": "13695004816",
                "type": "WEB_DATA_STREAM",
                "measurement_id": "G-2PCECPSKCR",
                "firebase_app_id": "1:1006304528804:web:d2479c8817799a28cfd931",
            },
        ],
        "uat": [
            {
                "stream_id": "14383415557",
                "type": "IOS_APP_DATA_STREAM",
                "firebase_app_id": "1:745506018753:ios:efea0fede200b1d1778b40",
            },
            {
                "stream_id": "14383500973",
                "type": "WEB_DATA_STREAM",
                "measurement_id": "G-H1KGXGZTCF",
                "firebase_app_id": "1:745506018753:web:9d0c1d3da8767c32778b40",
            },
            {
                "stream_id": "14383555179",
                "type": "ANDROID_APP_DATA_STREAM",
                "firebase_app_id": "1:745506018753:android:7d6bed4640373c95778b40",
            },
        ],
    },
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
        "event_category",
        "app_version",
    ],
    "required_events": [
        "growth_funnel_step_completed",
        "investor_activation_completed",
        "ria_activation_completed",
        "market_insights_loaded",
        "portfolio_viewed",
        "recommendation_viewed",
        "marketplace_profile_viewed",
        "import_parse_completed",
        "import_quality_gate_passed",
        "import_quality_gate_failed",
        "import_save_completed",
        "phone_verification_started",
        "phone_verification_completed",
        "persona_switched",
    ],
    "local_env_files": [
        ".env.local",
        ".env.uat.local",
        ".env.prod.local",
        "hushh-webapp/.env.local",
        "hushh-webapp/.env.local.local",
        "hushh-webapp/.env.uat.local",
        "hushh-webapp/.env.prod.local",
        "consent-protocol/.env",
    ],
}


def run_json_command(cmd: list[str]) -> object:
    return json.loads(subprocess.check_output(cmd, text=True))


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def normalize_secret_payload(raw: str) -> str:
    value = raw.strip()
    if not value:
        raise RuntimeError("empty service account payload")
    if (
        (value.startswith("'") and value.endswith("'")) or
        (value.startswith('"') and value.endswith('"'))
    ):
        value = shlex.split(value)[0]
    if not value.startswith("{") and Path(value).exists():
        return Path(value).read_text(encoding="utf-8")
    return value


def load_env_value_from_file(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        env_key, raw_value = line.split("=", 1)
        if env_key.strip() != key:
            continue
        value = raw_value.strip()
        if not value:
            return None
        if value.startswith("{"):
            return value
        try:
            parsed = shlex.split(value, posix=True)
            return parsed[0] if parsed else None
        except ValueError:
            return value.strip("'\"")
    return None


def validate_service_account_payload(raw: str) -> str:
    payload = normalize_secret_payload(raw)
    parsed = json.loads(payload)
    if parsed.get("type") != "service_account" or not parsed.get("client_email"):
        raise RuntimeError("analytics credential payload is not a service account JSON object")
    return payload


def load_service_account_json(args: argparse.Namespace) -> str:
    if args.service_account_json:
        return validate_service_account_payload(
            Path(args.service_account_json).read_text(encoding="utf-8")
        )

    env_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if env_path and Path(env_path).exists():
        return validate_service_account_payload(Path(env_path).read_text(encoding="utf-8"))

    for env_name in [args.secret_name, "FIREBASE_ADMIN_CREDENTIALS_JSON"]:
        env_value = os.environ.get(env_name)
        if env_value:
            return validate_service_account_payload(env_value)

    root = repo_root()
    for relative_path in DEFAULTS["local_env_files"]:
        value = load_env_value_from_file(root / relative_path, args.secret_name)
        if value:
            return validate_service_account_payload(value)
        if args.secret_name != "FIREBASE_ADMIN_CREDENTIALS_JSON":
            value = load_env_value_from_file(
                root / relative_path,
                "FIREBASE_ADMIN_CREDENTIALS_JSON",
            )
            if value:
                return validate_service_account_payload(value)

    secret_names = [args.secret_name]
    if "FIREBASE_ADMIN_CREDENTIALS_JSON" not in secret_names:
        secret_names.append("FIREBASE_ADMIN_CREDENTIALS_JSON")
    secret_projects = [args.secret_project]
    for project_id in [DEFAULTS["uat_project"], DEFAULTS["prod_project"]]:
        if project_id not in secret_projects:
            secret_projects.append(project_id)

    last_error: subprocess.CalledProcessError | None = None
    for secret_project in secret_projects:
        for secret_name in secret_names:
            try:
                return validate_service_account_payload(
                    subprocess.check_output(
                        [
                            "gcloud",
                            "secrets",
                            "versions",
                            "access",
                            "latest",
                            f"--secret={secret_name}",
                            f"--project={secret_project}",
                        ],
                        text=True,
                    )
                )
            except (json.JSONDecodeError, RuntimeError, subprocess.CalledProcessError) as error:
                if isinstance(error, subprocess.CalledProcessError):
                    last_error = error
                continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("unable to load analytics service account secret")


def build_session(args: argparse.Namespace, *, readwrite: bool = False) -> AuthorizedSession:
    payload = load_service_account_json(args)
    scopes = [
        "https://www.googleapis.com/auth/analytics.readonly",
    ]
    if readwrite:
        scopes.append("https://www.googleapis.com/auth/analytics.edit")
    creds = service_account.Credentials.from_service_account_info(
        json.loads(payload),
        scopes=scopes,
    )
    return AuthorizedSession(creds)


def ga_get(session: AuthorizedSession, path: str, version: str = "v1beta") -> object:
    url = f"https://analyticsadmin.googleapis.com/{version}/{path.lstrip('/')}"
    response = session.get(url)
    response.raise_for_status()
    return response.json()


def ga_post(
    session: AuthorizedSession,
    path: str,
    payload: dict,
    version: str = "v1beta",
) -> object:
    url = f"https://analyticsadmin.googleapis.com/{version}/{path.lstrip('/')}"
    response = session.post(url, json=payload)
    response.raise_for_status()
    return response.json()


def ga_data_run_report(session: AuthorizedSession, property_id: str, payload: dict) -> dict:
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"
    response = session.post(url, json=payload)
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


def bq_event_counts(
    project_id: str,
    dataset_id: str,
    required_events: list[str],
    excluded_streams: list[str],
) -> dict[str, int]:
    event_list = ", ".join(json.dumps(event_name) for event_name in required_events)
    excluded_stream_filter = ""
    if excluded_streams:
        excluded_list = ", ".join(json.dumps(stream_id) for stream_id in excluded_streams)
        excluded_stream_filter = f"AND stream_id NOT IN ({excluded_list})"
    query = f"""
    SELECT event_name, COUNT(*) AS event_count
    FROM `{project_id}.{dataset_id}.events_*`
    WHERE event_name IN ({event_list})
      {excluded_stream_filter}
    GROUP BY event_name
    ORDER BY event_name
    """
    try:
        rows = run_json_command(
            [
                "bq",
                "query",
                "--quiet",
                "--use_legacy_sql=false",
                "--format=json",
                query,
            ]
        )
    except subprocess.CalledProcessError:
        return {}
    if not isinstance(rows, list):
        return {}
    return {
        str(row["event_name"]): int(row.get("event_count", 0))
        for row in rows
        if row.get("event_name")
    }


def inspect_property(
    session: AuthorizedSession,
    property_id: str,
    project_id: str,
) -> dict:
    streams = ga_get(session, f"properties/{property_id}/dataStreams", version="v1beta").get(
        "dataStreams", []
    )
    key_events = ga_get(
        session, f"properties/{property_id}/keyEvents", version="v1beta"
    ).get("keyEvents", [])
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


def create_missing_custom_dimensions(summary: dict, args: argparse.Namespace) -> dict:
    session = build_session(args, readwrite=True)
    created: dict[str, list[str]] = {"production": [], "uat": []}
    property_by_label = {
        "production": args.prod_property,
        "uat": args.uat_property,
    }

    for label, payload in summary.items():
        existing = {entry["parameterName"] for entry in payload["custom_dimensions"]}
        for parameter_name in DEFAULTS["required_custom_dimensions"]:
            if parameter_name in existing:
                continue
            display_name = " ".join(part.capitalize() for part in parameter_name.split("_"))
            ga_post(
                session,
                f"properties/{property_by_label[label]}/customDimensions",
                {
                    "parameterName": parameter_name,
                    "displayName": display_name,
                    "description": "Governed Kai analytics observability parameter.",
                    "scope": "EVENT",
                },
                version="v1beta",
            )
            created[label].append(parameter_name)
    return created


def build_summary(args: argparse.Namespace) -> dict:
    session = build_session(args)
    return {
        "production": inspect_property(session, args.prod_property, args.prod_project),
        "uat": inspect_property(session, args.uat_property, args.uat_project),
    }


def validate(summary: dict) -> dict:
    findings: dict[str, list[str]] = {"high": [], "medium": [], "low": []}

    for label, payload in summary.items():
        streams_by_id = {
            entry["name"].split("/")[-1]: entry for entry in payload["streams"]
        }
        stream_ids = set(streams_by_id)
        types = {entry["type"] for entry in payload["streams"]}
        key_event_names = {entry["eventName"] for entry in payload["key_events"]}
        custom_dimensions_by_name = {
            entry["parameterName"]: entry for entry in payload["custom_dimensions"]
        }
        custom_dimension_names = set(custom_dimensions_by_name)

        if "WEB_DATA_STREAM" not in types or "IOS_APP_DATA_STREAM" not in types or "ANDROID_APP_DATA_STREAM" not in types:
            findings["high"].append(f"{label}: missing one or more primary stream types")

        for expected_stream in DEFAULTS["expected_streams"][label]:
            stream_id = expected_stream["stream_id"]
            stream = streams_by_id.get(stream_id)
            if not stream:
                findings["high"].append(f"{label}: missing expected stream {stream_id}")
                continue
            expected_type = expected_stream["type"]
            if stream.get("type") != expected_type:
                findings["high"].append(
                    f"{label}: stream {stream_id} type is {stream.get('type')} not {expected_type}"
                )
            measurement_id = expected_stream.get("measurement_id")
            if measurement_id:
                actual_measurement_id = (
                    stream.get("webStreamData", {}).get("measurementId")
                    if isinstance(stream.get("webStreamData"), dict)
                    else None
                )
                if actual_measurement_id != measurement_id:
                    findings["high"].append(
                        f"{label}: stream {stream_id} measurement ID is {actual_measurement_id} not {measurement_id}"
                    )
            firebase_app_id = expected_stream.get("firebase_app_id")
            if firebase_app_id:
                stream_data_key = {
                    "ANDROID_APP_DATA_STREAM": "androidAppStreamData",
                    "IOS_APP_DATA_STREAM": "iosAppStreamData",
                    "WEB_DATA_STREAM": "webStreamData",
                }.get(expected_type)
                stream_data = stream.get(stream_data_key) if stream_data_key else None
                actual_firebase_app_id = (
                    stream_data.get("firebaseAppId") if isinstance(stream_data, dict) else None
                )
                if actual_firebase_app_id != firebase_app_id:
                    findings["high"].append(
                        f"{label}: stream {stream_id} Firebase app ID is {actual_firebase_app_id} not {firebase_app_id}"
                    )

        for event_name in DEFAULTS["required_key_events"]:
            if event_name not in key_event_names:
                findings["high"].append(f"{label}: missing key event {event_name}")

        for parameter_name in DEFAULTS["required_custom_dimensions"]:
            if parameter_name not in custom_dimension_names:
                findings["high"].append(f"{label}: missing custom dimension {parameter_name}")
                continue
            scope = custom_dimensions_by_name[parameter_name].get("scope")
            if scope != "EVENT":
                findings["high"].append(
                    f"{label}: custom dimension {parameter_name} scope is {scope} not EVENT"
                )

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


def build_reporting_health(args: argparse.Namespace, summary: dict) -> dict:
    session = build_session(args)
    required_events = list(DEFAULTS["required_events"])
    payload = {
        "dateRanges": [{"startDate": args.date_start, "endDate": args.date_end}],
        "dimensions": [{"name": "eventName"}],
        "metrics": [{"name": "eventCount"}],
        "dimensionFilter": {
            "filter": {
                "fieldName": "eventName",
                "inListFilter": {"values": required_events},
            }
        },
    }
    results: dict[str, dict] = {}
    for label, property_payload in summary.items():
        property_id = property_payload["property_id"]
        project_id = property_payload["project_id"]
        dataset_id = property_payload["export_dataset"]
        data_api_counts: dict[str, int] = {}
        try:
            report = ga_data_run_report(session, property_id, payload)
            for row in report.get("rows", []):
                event_name = row["dimensionValues"][0]["value"]
                count = int(row["metricValues"][0]["value"])
                data_api_counts[event_name] = count
        except Exception as error:  # noqa: BLE001 - report the API failure as health data.
            data_api_counts = {}
            data_api_error = str(error)
        else:
            data_api_error = None

        excluded_streams = (
            DEFAULTS["prod_excluded_streams"] if label == "production" else []
        )
        bq_counts = (
            bq_event_counts(project_id, dataset_id, required_events, excluded_streams)
            if dataset_id in property_payload["datasets"] and property_payload["export_tables"]
            else {}
        )
        results[label] = {
            "date_range": {"start": args.date_start, "end": args.date_end},
            "ga_data_api_event_counts": data_api_counts,
            "ga_data_api_error": data_api_error,
            "bigquery_event_counts": bq_counts,
            "missing_ga_data_api_events": [
                event_name for event_name in required_events if data_api_counts.get(event_name, 0) == 0
            ],
            "missing_bigquery_events": [
                event_name for event_name in required_events if bq_counts.get(event_name, 0) == 0
            ],
        }
    return results


def build_health(args: argparse.Namespace) -> dict:
    summary = build_summary(args)
    admin_validation = validate(summary)
    reporting = build_reporting_health(args, summary)
    high: list[str] = []

    if not admin_validation["ok"]:
        high.extend(admin_validation["findings"]["high"])

    for label, payload in reporting.items():
        if payload["ga_data_api_error"]:
            high.append(f"{label}: GA Data API check failed: {payload['ga_data_api_error']}")
        if label == "uat":
            for event_name in [
                "growth_funnel_step_completed",
                "investor_activation_completed",
            ]:
                if event_name in payload["missing_ga_data_api_events"]:
                    high.append(f"{label}: GA Data API has no recent {event_name} rows")
                if event_name in payload["missing_bigquery_events"]:
                    high.append(f"{label}: BigQuery export has no {event_name} rows")

    return {
        "ok": not high,
        "admin_validation": admin_validation,
        "reporting": reporting,
        "confidence_blockers": high,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect Kai analytics observability surfaces")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("summary", "validate", "health", "ensure-custom-dimensions"):
        command = sub.add_parser(name)
        command.add_argument("--service-account-json")
        command.add_argument("--secret-project", default=DEFAULTS["secret_project"])
        command.add_argument("--secret-name", default=DEFAULTS["secret_name"])
        command.add_argument("--prod-property", default=DEFAULTS["prod_property"])
        command.add_argument("--uat-property", default=DEFAULTS["uat_property"])
        command.add_argument("--prod-project", default=DEFAULTS["prod_project"])
        command.add_argument("--uat-project", default=DEFAULTS["uat_project"])
        if name == "health":
            command.add_argument("--date-start", default="30daysAgo")
            command.add_argument("--date-end", default="today")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = build_summary(args)
    if args.cmd == "summary":
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0
    if args.cmd == "ensure-custom-dimensions":
        created = create_missing_custom_dimensions(summary, args)
        print(json.dumps({"created": created}, indent=2, sort_keys=True))
        return 0
    if args.cmd == "health":
        result = build_health(args)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1
    result = validate(summary)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
