"""Plan or provision fixed isolated PLG resources. No app deploy or acceptance.

The release owner executes this reviewed helper under normal Dev/UAT authority.
No provider credentials, production rows, email subscriptions or schedulers are
copied. The default phase only emits a nonsecret plan.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import time
from contextlib import closing, contextmanager
from pathlib import Path

import release_source
from qualification_database import (
    configure_runtime_grants,
    ensure_namespace,
    inspect_baseline,
)
from qualification_foundation import load_contract
from qualification_resources import Cloud, ensure_resources
from qualification_target import (
    BASELINE,
    DATABASE,
    RUNTIME_SECRETS,
    SOURCE,
    QualificationError,
    Target,
    require,
)


def source_boundary() -> dict:
    proof = release_source.qualify_source(SOURCE)
    require(
        proof["baselineSha"] == BASELINE
        and proof["sourceQualified"] is True
        and proof["trafficAuthorized"] is False,
        "qualification_source_boundary_changed",
    )
    return proof


def foundation_contract() -> str:
    """Only a reviewed, tracked canonical contract, never an operator's dump."""
    return load_contract()[1]


@contextmanager
def owned_proxy(target: Target):
    """Connect only to the fixed nonproduction instance; own and settle the child."""
    binary = shutil.which("cloud-sql-proxy")
    require(binary is not None, "qualification_cloudsql_proxy_required")
    with socket.socket() as check:
        check.settimeout(1)
        require(
            check.connect_ex(("127.0.0.1", target.proxy_port)) != 0,
            "qualification_proxy_port_occupied",
        )
    command = [
        binary,
        "--address",
        "127.0.0.1",
        "--port",
        str(target.proxy_port),
    ]
    if os.environ.get("GOOGLE_GHA_CREDS_PATH"):
        command.append("--credentials-file=" + os.environ["GOOGLE_GHA_CREDS_PATH"])
    command.append(target.instance)
    child = subprocess.Popen(  # noqa: S603 -- fixed proxy and environment-local instance.
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            require(child.poll() is None, "qualification_proxy_exited")
            with socket.socket() as check:
                check.settimeout(0.5)
                if check.connect_ex(("127.0.0.1", target.proxy_port)) == 0:
                    break
            require(time.monotonic() < deadline, "qualification_proxy_startup_timeout")
            time.sleep(0.25)
        yield
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


def connect(target: Target, *, database: str, user: str, password: str):
    import psycopg2

    require(database in {"postgres", DATABASE}, "qualification_database_invalid")
    return psycopg2.connect(
        host="127.0.0.1",
        port=target.proxy_port,
        dbname=database,
        user=user,
        password=password,
        connect_timeout=10,
        options="-c statement_timeout=15000",
    )


def provision(target: Target) -> dict:
    """Creates empty resource namespace only. Does not install a guessed schema."""
    require(
        shutil.which("cloud-sql-proxy") is not None,
        "qualification_cloudsql_proxy_required",
    )
    user = os.environ.get("PLG_QUALIFICATION_ADMIN_USER", "")
    password = os.environ.get("PLG_QUALIFICATION_ADMIN_PASSWORD", "")
    require(
        bool(user and password), "qualification_environment_admin_material_required"
    )
    cloud = Cloud(target)
    versions, values = ensure_resources(cloud, target)
    try:
        with owned_proxy(target):
            with closing(
                connect(target, database="postgres", user=user, password=password)
            ) as admin:
                admin.autocommit = True
                database = ensure_namespace(
                    admin,
                    target,
                    {
                        key: values[key].decode()
                        for key in ("DB_PASSWORD", "MIGRATOR_DB_PASSWORD")
                    },
                )
            with closing(
                connect(
                    target,
                    database=DATABASE,
                    user=values["MIGRATOR_DB_USER"].decode(),
                    password=values["MIGRATOR_DB_PASSWORD"].decode(),
                )
            ) as migrator:
                with migrator:
                    configure_runtime_grants(migrator)
            with closing(
                connect(
                    target,
                    database=DATABASE,
                    user=values["DB_USER"].decode(),
                    password=values["DB_PASSWORD"].decode(),
                )
            ) as runtime:
                with runtime.cursor() as cursor:
                    cursor.execute("SELECT current_user")
                    require(
                        cursor.fetchone() == (values["DB_USER"].decode(),),
                        "qualification_runtime_database_identity_mismatch",
                    )
        return target.plan() | {
            "status": "namespace-ready-for-reviewed-foundation",
            "secretVersions": versions,
            "databaseSetup": database,
        }
    finally:
        values.clear()


def preflight(target: Target) -> dict:
    digest = foundation_contract()
    user = os.environ.get("PLG_QUALIFICATION_ADMIN_USER", "")
    password = os.environ.get("PLG_QUALIFICATION_ADMIN_PASSWORD", "")
    require(
        bool(user and password), "qualification_environment_admin_material_required"
    )
    with (
        owned_proxy(target),
        closing(
            connect(target, database=DATABASE, user=user, password=password)
        ) as connection,
    ):
        connection.set_session(readonly=True)
        boundary = inspect_baseline(connection, target)
    return target.plan() | {
        "status": "structural-boundary-verified",
        "foundationSha256": digest,
        "databaseBoundary": boundary,
    }


def candidate_document(
    target: Target, report_path: Path, image: str, run_id: str
) -> dict:
    report = json.loads(report_path.read_bytes())
    require(
        report.get("sourceSha") == SOURCE
        and report.get("baselineSha") == BASELINE
        and report.get("environment") == target.environment
        and report.get("project") == target.project
        and report.get("database") == DATABASE
        and report.get("service") == target.plan()["service"]
        and report.get("status") == "namespace-ready-for-reviewed-foundation",
        "qualification_namespace_report_mismatch",
    )
    versions = report.get("secretVersions", {})
    require(isinstance(versions, dict), "qualification_secret_versions_invalid")
    # This is a manifest, not proof that its image/source, IAM, secret versions or
    # database currently qualify. The release workflow must verify all of them.
    return target.service_document(
        image, {name: versions.get(name) for name in RUNTIME_SECRETS}, run_id
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument(
        "--phase",
        choices=("plan", "namespace", "preflight", "candidate-document"),
        default="plan",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--namespace-report", type=Path)
    parser.add_argument("--image-reference", default="")
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()
    target = Target(args.environment)
    source_boundary()
    require(
        args.namespace_report is None
        or args.namespace_report.resolve() != args.output.resolve(),
        "qualification_report_input_output_collision",
    )
    # Write before any side effect: an interrupted namespace phase needs explicit
    # reconciliation, not a blind rerun justified by a missing final report.
    report = target.plan() | {"phase": args.phase, "status": "requested"}
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    try:
        if args.phase == "namespace":
            report = provision(target)
        elif args.phase == "preflight":
            report = preflight(target)
        elif args.phase == "candidate-document":
            require(
                args.namespace_report is not None,
                "qualification_namespace_report_required",
            )
            report = candidate_document(
                target, args.namespace_report, args.image_reference, args.run_id
            )
        else:
            report = target.plan() | {"status": "planned"}
    except Exception as error:
        code = (
            str(error)
            if isinstance(error, QualificationError)
            else "qualification_operation_unverified"
        )
        report.update(status="needs-reconciliation", error=code)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        raise QualificationError(code) from None
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except QualificationError as error:
        raise SystemExit(str(error)) from None
