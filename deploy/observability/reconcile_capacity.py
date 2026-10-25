#!/usr/bin/env python3
"""Reconcile managed operational log metrics, alert policies, and dashboards.

The default is a read-only plan. Pass --apply after reviewing the plan. This
entry point intentionally does not enable APIs, alter IAM, jobs, or datasets.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
_AUTH_SPEC = importlib.util.spec_from_file_location("auth_reliability", ROOT / "auth_reliability.py")
assert _AUTH_SPEC and _AUTH_SPEC.loader
_AUTH = importlib.util.module_from_spec(_AUTH_SPEC)
_AUTH_SPEC.loader.exec_module(_AUTH)
_CAPACITY_SPEC = importlib.util.spec_from_file_location(
    "runtime_capacity_budget", ROOT.parents[1] / "scripts/ci/runtime-capacity-budget.py"
)
assert _CAPACITY_SPEC and _CAPACITY_SPEC.loader
_CAPACITY = importlib.util.module_from_spec(_CAPACITY_SPEC)
_CAPACITY_SPEC.loader.exec_module(_CAPACITY)
DEFAULT_EMAILS = ("manish@hushh.ai", "ankit@hushh.ai", "kushal@hushh.ai")
METRICS = (
    "obs_request_summary_count",
    "obs_agent_stream_failure_count",
    "obs_unexpected_error_count",
    "obs_account_mail_failure_count",
    "obs_data_health_anomaly_count",
    "obs_db_pool_wait_ms",
    "obs_db_pool_acquire_timeout_count",
    "obs_short_read_duration_ms",
    "obs_one_voice_latency_ms",
    "obs_one_voice_client_perf_ms",
    "obs_agent_chat_first_visible_ms",
    "obs_agent_chat_first_visible_count",
    "obs_agent_chat_first_answer_ms",
    "obs_agent_chat_first_answer_count",
    "obs_agent_chat_terminal_count",
    "obs_agent_chat_no_answer_count",
    "obs_azure_model_error_count",
)
VOICE_METRICS = ("obs_one_voice_latency_ms", "obs_one_voice_client_perf_ms")
POLICIES = (
    "backend-5xx-policy",
    "agent-stream-failures-policy",
    "backend-latency-policy",
    "unexpected-errors-policy",
    "account-mail-failures-policy",
    "data-health-anomaly-policy",
    "pod-fleet-5xx-policy",
    "sql-connections-warning-policy",
    "sql-connections-critical-policy",
    "db-pool-wait-policy",
    "db-pool-timeout-policy",
    "sql-cpu-policy",
)
PROVIDER_POLICIES = ("provider-errors-policy",)
PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,61}[a-z0-9]$")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")


def cli(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--sql-instance", default="")
    _AUTH.add_arguments(parser)
    parser.add_argument("--commerce-only", action="store_true")
    parser.add_argument("--include-commerce", action="store_true")
    parser.add_argument("--console-only", action="store_true")
    parser.add_argument("--dashboard-id", default="hushh-observability-managed")
    parser.add_argument(
        "--provider-only", action="store_true",
        help="Manage provider availability alerts/dashboard without SQL or log-metric changes",
    )
    parser.add_argument(
        "--email",
        action="append",
        help="Alert recipient; repeat for multiple recipients",
    )
    parser.add_argument("--backend-service", default="consent-protocol")
    parser.add_argument("--frontend-service", default="hushh-webapp")
    parser.add_argument(
        "--apply", action="store_true", help="Write the reviewed changes"
    )
    parser.add_argument(
        "--voice-only",
        action="store_true",
        help="Reconcile One Voice metrics and the managed dashboard without alerts or channels",
    )
    args = parser.parse_args(argv)
    _AUTH.validate_arguments(parser, args)
    if args.commerce_only and args.voice_only:
        parser.error("--commerce-only and --voice-only select different provisioners")
    if args.provider_only and (args.voice_only or args.sql_instance or args.commerce_only or args.include_commerce):
        parser.error("--provider-only cannot be combined with application or commerce provisioners")
    if not PROJECT_RE.fullmatch(args.project):
        parser.error("--project must be a Google Cloud project ID")
    for key in ("sql_instance", "backend_service", "frontend_service", "dashboard_id"):
        if key == "sql_instance" and (args.auth_only or args.provider_only or (args.commerce_only and not args.sql_instance)):
            continue
        if not NAME_RE.fullmatch(getattr(args, key)):
            parser.error(f"--{key.replace('_', '-')} must be a resource name")
    if args.console_only and args.email:
        parser.error("--console-only cannot be combined with --email")
    args.email = [] if _AUTH.delivery_disabled(args) else list(dict.fromkeys(args.email or DEFAULT_EMAILS))
    if not all(
        re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) for email in args.email
    ):
        parser.error("--email must be an email address")
    if not args.auth_only and not args.provider_only and not args.commerce_only:
        try:
            _CAPACITY.sql_alert_thresholds(
                json.loads(_CAPACITY.DEFAULT_PROFILE.read_text()),
                args.project,
                args.sql_instance,
            )
        except ValueError as exc:
            parser.error(str(exc))
    return args


def run(*command: str, allow_missing: bool = False) -> Any:
    try:
        result = subprocess.run(command, text=True, capture_output=True, check=False, timeout=60)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{' '.join(command[:4])} timed out") from None
    if result.returncode:
        if allow_missing and (
            "NOT_FOUND" in result.stderr.upper() or "NOT FOUND" in result.stderr.upper()
        ):
            return None
        raise RuntimeError(f"{' '.join(command[:4])} failed: {result.stderr.strip()}")
    if "--format=json" in command:
        return json.loads(result.stdout)
    return result.stdout.strip()


def render(path: Path, args: argparse.Namespace) -> dict[str, Any]:
    source = path.read_text()
    thresholds = {} if args.auth_only or args.provider_only or args.commerce_only else _CAPACITY.sql_alert_thresholds(
        json.loads(_CAPACITY.DEFAULT_PROFILE.read_text()), args.project, args.sql_instance
    )
    substitutions = {
        "__PROJECT_ID__": args.project,
        "__SQL_INSTANCE__": args.sql_instance,
        "__BACKEND_SERVICE__": args.backend_service,
        "__FRONTEND_SERVICE__": args.frontend_service,
    }
    substitutions.update({f"__SQL_CONNECTION_{key.upper()}__": str(value)
                          for key, value in thresholds.items()})
    for before, after in substitutions.items():
        source = source.replace(before, after)
    if re.search(r"__[A-Z_]+__", source):
        raise ValueError(f"Unrendered placeholder in {path}")
    return json.loads(source)


def config_file(config: dict[str, Any]) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        json.dump(config, handle)
        return handle.name


def write_config(config: dict[str, Any], action: list[str]) -> None:
    path = Path(config_file(config))
    try:
        run(*(arg.replace("__CONFIG__", str(path)) for arg in action))
    finally:
        path.unlink(missing_ok=True)


def same_config(
    current: dict[str, Any], desired: dict[str, Any], fields: tuple[str, ...]
) -> bool:
    # Protobuf JSON omits empty repeated fields; an empty channel list is still
    # an explicit no-delivery policy, not drift to repair on every run.
    return all(
        current.get(field, [] if field == "notificationChannels" else None)
        == desired.get(field, [] if field == "notificationChannels" else None)
        for field in fields
    )


def same_log_metric(current: dict[str, Any], desired: dict[str, Any]) -> bool:
    """Compare authored fields while ignoring server-assigned descriptor metadata."""
    if not same_config(
        current, desired, ("description", "filter", "valueExtractor", "bucketOptions")
    ):
        return False
    if "labelExtractors" not in desired:
        return True
    if current.get("labelExtractors", {}) != desired["labelExtractors"]:
        return False
    actual_descriptor = current.get("metricDescriptor", {})
    expected_descriptor = desired["metricDescriptor"]
    if any(
        actual_descriptor.get(field) != expected_descriptor[field]
        for field in ("metricKind", "valueType", "unit")
    ):
        return False
    def authored_labels(labels: list[dict[str, Any]]) -> list[tuple[Any, Any, Any]]:
        return sorted(
            (
                # Cloud Monitoring omits the default STRING value type on readback.
                label.get("key"),
                label.get("valueType", "STRING"),
                label.get("description", ""),
            )
            for label in labels
        )
    return authored_labels(actual_descriptor.get("labels", [])) == authored_labels(
        expected_descriptor["labels"]
    )


def reconcile_dashboard(args: argparse.Namespace) -> None:
    project = args.project
    template = "dashboard-provider.json.in" if args.provider_only else "dashboard-observability.json.in"
    desired_dashboard = render(ROOT / template, args)
    if not args.provider_only:
        desired_dashboard["name"] = f"projects/{project}/dashboards/{args.dashboard_id}"
        desired_dashboard["gridLayout"]["widgets"] = [
            widget for widget in desired_dashboard["gridLayout"]["widgets"]
            if (widget.get("title", "").startswith("Scope Commerce:")
                if args.commerce_only
                else args.include_commerce or not widget.get("title", "").startswith("Scope Commerce:"))
        ]
    dashboard_name = desired_dashboard["name"]
    current_dashboard = run(
        "gcloud",
        "monitoring",
        "dashboards",
        "describe",
        dashboard_name,
        "--project",
        project,
        "--format=json",
        allow_missing=True,
    )
    dashboard_fields = ("displayName", "labels", "gridLayout")
    # gridLayout.columns is an int64: API JSON returns its decimal string.
    desired_dashboard["gridLayout"]["columns"] = str(
        desired_dashboard["gridLayout"]["columns"]
    )
    if current_dashboard and same_config(
        current_dashboard, desired_dashboard, dashboard_fields
    ):
        print(f"dashboard unchanged: {dashboard_name}")
    else:
        print(
            f"dashboard {'update' if current_dashboard else 'create'}: {dashboard_name}"
        )
        if args.apply:
            if current_dashboard:
                if not current_dashboard.get("etag"):
                    raise RuntimeError("Dashboard etag unavailable; refusing update")
                desired_dashboard["etag"] = current_dashboard["etag"]
                command = [
                    "gcloud",
                    "monitoring",
                    "dashboards",
                    "update",
                    dashboard_name,
                    "--project",
                    project,
                    "--config-from-file=__CONFIG__",
                ]
            else:
                command = [
                    "gcloud",
                    "monitoring",
                    "dashboards",
                    "create",
                    "--project",
                    project,
                    "--config-from-file=__CONFIG__",
                ]
            write_config(desired_dashboard, command)


def reconcile(args: argparse.Namespace) -> None:
    project = args.project
    current_metrics = {} if args.provider_only else {
        item["name"].split("/")[-1]: item
        for item in run(
            "gcloud",
            "logging",
            "metrics",
            "list",
            "--project",
            project,
            "--format=json",
        )
    }
    metric_names = _AUTH.METRICS if args.auth_only else () if args.provider_only or args.commerce_only else VOICE_METRICS if args.voice_only else METRICS
    for name in metric_names:
        desired = render(ROOT / "log-metrics" / f"{name}.json", args)
        current = current_metrics.get(name)
        if current and same_log_metric(current, desired):
            print(f"metric unchanged: {name}")
            continue
        verb = "update" if current else "create"
        print(f"metric {verb}: {name}")
        if args.apply:
            write_config(
                desired,
                [
                    "gcloud",
                    "logging",
                    "metrics",
                    verb,
                    name,
                    "--config-from-file=__CONFIG__",
                    "--project",
                    project,
                ],
            )

    if args.voice_only:
        reconcile_dashboard(args)
        return

    channels = run(
        "gcloud",
        "beta",
        "monitoring",
        "channels",
        "list",
        "--project",
        project,
        "--format=json",
    )
    channel_names = []
    for email in args.email:
        matches = [
            channel
            for channel in channels
            if channel.get("type") == "email"
            and channel.get("labels", {}).get("email_address") == email
        ]
        _AUTH.validate_channel(args, matches, email)
        if matches:
            channel_name = matches[0]["name"]
            print(f"channel unchanged: {channel_name}")
        else:
            print(f"channel create: {email}")
            channel_name = f"__NEW_EMAIL_CHANNEL_{len(channel_names)}__"
            if args.apply:
                channel = run(
                    "gcloud",
                    "beta",
                    "monitoring",
                    "channels",
                    "create",
                    "--project",
                    project,
                    f"--display-name=Capacity Alerts ({email})",
                    "--type=email",
                    f"--channel-labels=email_address={email}",
                    "--format=json",
                )
                channel_name = channel["name"]
        channel_names.append(channel_name)

    policies = run(
        "gcloud",
        "monitoring",
        "policies",
        "list",
        "--project",
        project,
        "--format=json",
    )
    by_name: dict[str, list[dict[str, Any]]] = {}
    for policy in policies:
        by_name.setdefault(policy["displayName"], []).append(policy)
    selected_policies = _AUTH.selected_policies(args) if args.auth_only else ("scope-commerce-policy",) if args.commerce_only else PROVIDER_POLICIES if args.provider_only else POLICIES
    if args.include_commerce and not args.commerce_only:
        selected_policies += ("scope-commerce-policy",)
    for slug in selected_policies:
        desired = render(ROOT / "alerts" / f"{slug}.json.in", args)
        _AUTH.configure_policy(args, slug, desired)
        current_matches = by_name.get(desired["displayName"], [])
        if len(current_matches) > 1:
            raise RuntimeError(
                f"Duplicate policies named {desired['displayName']}; resolve before applying"
            )
        purpose = desired.get("userLabels", {}).get("incident_purpose")
        if purpose not in {"actionable", "diagnostic"}:
            raise ValueError(f"Missing incident purpose: {desired['displayName']}")
        if desired.get("enabled") is not (purpose == "actionable"):
            raise ValueError(f"Incident purpose disagrees with enabled: {desired['displayName']}")
        # Diagnostic metrics remain available, but cannot open incidents or send mail.
        desired["notificationChannels"] = channel_names if purpose == "actionable" else []
        current = current_matches[0] if current_matches else None
        fields = (
            "documentation",
            "combiner",
            "enabled",
            "notificationChannels",
            "userLabels",
            "conditions",
            "severity",
            "alertStrategy",
        )
        # Monitoring assigns condition resource names; compare their authored content.
        if current:
            current_conditions = [
                {key: value for key, value in condition.items() if key != "name"}
                for condition in current.get("conditions", [])
            ]
            for condition in current_conditions:
                # Monitoring omits the default double value (0) on readback.
                if "conditionThreshold" in condition:
                    condition["conditionThreshold"] = {
                        "thresholdValue": 0, **condition["conditionThreshold"]
                    }
            if same_config(
                {**current, "conditions": current_conditions}, desired, fields
            ):
                print(f"policy unchanged: {desired['displayName']}")
                continue
        verb = "update" if current else "create"
        print(f"policy {verb}: {desired['displayName']}")
        if args.apply:
            if current:
                desired["name"] = current["name"]
                if current.get("etag"):
                    desired["etag"] = current["etag"]
                command = [
                    "gcloud",
                    "monitoring",
                    "policies",
                    "update",
                    current["name"],
                    "--project",
                    project,
                    "--policy-from-file=__CONFIG__",
                ]
            else:
                command = [
                    "gcloud",
                    "monitoring",
                    "policies",
                    "create",
                    "--project",
                    project,
                    "--policy-from-file=__CONFIG__",
                ]
            write_config(desired, command)

    if not args.auth_only:
        reconcile_dashboard(args)


if __name__ == "__main__":
    try:
        reconcile(cli())
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
