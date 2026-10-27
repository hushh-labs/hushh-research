"""Pure source qualification for one recorded PLG successor; never traffic authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RECORD = Path(__file__).with_name("production-source.json")
BASELINE_SHA = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
POLICY = "consent-protocol/config/account-deletion-authority.json"
POLICY_SHA256 = "39ade7f9e38ca0409e2d8c4a2017f5014da41fb7030699aca8863a2c2d29b4ce"
RUNTIME = "consent-protocol/hushh_mcp/services/plg_outcomes.py"
SOURCE_TEST = "consent-protocol/tests/test_plg_memory_query_postgres.py"
MANIFEST = "consent-protocol/scripts/test-ci.manifest.txt"
ALLOWED_CHANGES = {RUNTIME: "M", SOURCE_TEST: "A", MANIFEST: "M"}
RUNTIME_SHA256 = {
    "before": "0fb7db24866ea24ecbc8e2ef395baab1c36eaebff750f8fb71d2741a97c303b8",
    "after": "e51e996da2ace6f9c129ae17ce3fd9c808bc5afefbb3959590ec6d4b85179a82",
}
PHONE_RELATIONS = (
    "account_phone_transfers",
    "account_phone_auth_fences",
    "account_phone_recovery_continuations",
    "account_device_actions",
)
PROTECTED_PATHS = (
    "hushh-webapp",
    "contracts",
    "deploy",
    ".github",
    ".gcloudignore",
    "consent-protocol/api",
    "consent-protocol/db",
    "consent-protocol/config",
    "consent-protocol/hushh_mcp/runtime_providers",
    "consent-protocol/hushh_mcp/hushh_adk",
    "consent-protocol/Dockerfile",
    "consent-protocol/requirements.txt",
    "consent-protocol/pyproject.toml",
    "consent-protocol/uv.lock",
)
FIXED_RECORD = {
    "schemaVersion": 1,
    "kind": "plg-only-source-v1",
    "baselineSha": BASELINE_SHA,
    "project": "hushh-pda",
    "region": "us-central1",
    "scope": "backend",
    "services": ["consent-protocol"],
    "frontendSha": BASELINE_SHA,
    "providerContractVersion": 2,
    "authorityPolicySha256": POLICY_SHA256,
    "migrations": "none",
    "replacementAccounts": 0,
    "requiredAbsentTables": list(PHONE_RELATIONS),
}


class Refused(ValueError):
    """A redacted source refusal, without repository content or cloud access."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def _run_git(*arguments: str) -> subprocess.CompletedProcess:
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    try:
        return subprocess.run(  # noqa: S603 -- fixed Git executable and validated object identifiers.
            ["git", "--no-optional-locks", *arguments],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("PLG source Git read unavailable") from None


def _git(*arguments: str) -> bytes:
    result = _run_git(*arguments)
    require(result.returncode == 0, "PLG source Git read refused")
    return result.stdout


def _object(sha: str, path: str) -> tuple[str, str, str] | None:
    raw = _git("ls-tree", "-z", sha, "--", path)
    if not raw:
        return None
    rows = raw.split(b"\0")
    require(len(rows) == 2 and rows[-1] == b"", "Ambiguous PLG source tree entry")
    metadata, actual_path = rows[0].split(b"\t", 1)
    require(actual_path.decode() == path, "PLG source tree path changed")
    fields = metadata.decode().split()
    require(len(fields) == 3, "Invalid PLG source tree entry")
    return tuple(fields)


def _json_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate PLG source record field")
        result[key] = value
    return result


def _load_record() -> tuple[dict, bytes]:
    try:
        raw = RECORD.read_bytes()
        record = json.loads(raw, object_pairs_hook=_json_pairs)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise Refused("Canonical PLG source record unavailable") from None
    require(isinstance(record, dict), "Invalid PLG source record")
    return record, raw


def _check_record(sha: str, record: dict) -> None:
    require(
        isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) is not None,
        "Exact PLG source SHA required",
    )
    require(
        set(record) == set(FIXED_RECORD) | {"sourceSha", "changes"},
        "PLG source record fields changed",
    )
    require(
        all(record[key] == value for key, value in FIXED_RECORD.items()),
        "PLG source boundary changed",
    )
    require(
        all(
            type(record[key]) is int
            for key in (
                "schemaVersion",
                "providerContractVersion",
                "replacementAccounts",
            )
        ),
        "Invalid PLG source record version",
    )
    require(
        record["sourceSha"] == sha and sha != BASELINE_SHA,
        "Source is not the recorded PLG successor",
    )


def _check_changes(sha: str, rows: object) -> None:
    require(
        isinstance(rows, list) and len(rows) == len(ALLOWED_CHANGES),
        "PLG source change inventory changed",
    )
    changes = {}
    for row in rows:
        require(
            isinstance(row, dict)
            and set(row) == {"path", "status", "beforeBlob", "afterBlob"},
            "Invalid PLG change record",
        )
        path = row["path"]
        require(
            isinstance(path, str) and path in ALLOWED_CHANGES and path not in changes,
            "Unreviewed PLG source path",
        )
        require(row["status"] == ALLOWED_CHANGES[path], "PLG source status changed")
        for key in ("beforeBlob", "afterBlob"):
            value = row[key]
            require(
                (key == "beforeBlob" and row["status"] == "A" and value is None)
                or (
                    isinstance(value, str)
                    and re.fullmatch(r"[0-9a-f]{40}", value) is not None
                ),
                "Invalid PLG source blob pin",
            )
        for source, key in ((BASELINE_SHA, "beforeBlob"), (sha, "afterBlob")):
            entry = _object(source, path)
            require(
                (entry is None and row[key] is None)
                or (
                    entry is not None
                    and entry[:2] == ("100644", "blob")
                    and entry[2] == row[key]
                ),
                "PLG source blob or file mode changed",
            )
        changes[path] = row["status"]
    actual = _git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        "-z",
        BASELINE_SHA,
        sha,
        "--",
    ).split(b"\0")
    require(
        actual[-1] == b"" and len(actual) == 2 * len(changes) + 1,
        "Unreviewed changes outside the PLG patch",
    )
    require(
        {
            actual[i + 1].decode(): actual[i].decode()
            for i in range(0, len(actual) - 1, 2)
        }
        == ALLOWED_CHANGES,
        "Unreviewed changes outside the PLG patch",
    )


def _check_runtime_and_manifest(sha: str) -> None:
    for source, phase in ((BASELINE_SHA, "before"), (sha, "after")):
        blob = _git("show", f"{source}:{RUNTIME}")
        require(
            hashlib.sha256(blob).hexdigest() == RUNTIME_SHA256[phase],
            "Reviewed PLG runtime body changed",
        )
    before = _git("show", f"{BASELINE_SHA}:{MANIFEST}").decode().splitlines()
    after = _git("show", f"{sha}:{MANIFEST}").decode().splitlines()
    test_entry = SOURCE_TEST.removeprefix("consent-protocol/")
    require(
        test_entry not in before and after.count(test_entry) == 1,
        "PLG PostgreSQL test must be registered exactly once",
    )
    after.remove(test_entry)
    require(after == before, "PLG test registration changed unrelated execution")


def _check_policy(sha: str) -> None:
    policy = _git("show", f"{sha}:{POLICY}")
    require(
        hashlib.sha256(policy).hexdigest() == POLICY_SHA256
        and json.loads(policy).get("version") == 1,
        "PLG authority policy changed",
    )


def _protected_paths(sha: str) -> dict:
    protected = {}
    for path in PROTECTED_PATHS:
        baseline, target = _object(BASELINE_SHA, path), _object(sha, path)
        require(baseline == target, "Protected PLG predecessor source changed")
        protected[path] = target[2] if target else None
    return protected


def _check_phone_absence(sha: str) -> None:
    phone = _run_git(
        "grep",
        "-IlE",
        "|".join((*PHONE_RELATIONS, "phone_unlink")),
        sha,
        "--",
        "consent-protocol/api",
        "consent-protocol/hushh_mcp",
        "consent-protocol/db",
        "consent-protocol/server.py",
        "consent-protocol/server_drive_worker.py",
    )
    require(
        phone.returncode == 1 and not phone.stdout and not phone.stderr,
        "PLG successor phone producer absence unverified",
    )


def _qualify(sha: str, record: dict, raw: bytes) -> dict:
    _check_record(sha, record)
    require(
        _git("cat-file", "-t", sha).strip() == b"commit", "PLG source is not a commit"
    )
    _git("merge-base", "--is-ancestor", BASELINE_SHA, sha)
    _check_changes(sha, record["changes"])
    _check_runtime_and_manifest(sha)
    _check_policy(sha)
    protected = _protected_paths(sha)
    _check_phone_absence(sha)
    return {
        **record,
        "recordSha256": hashlib.sha256(raw).hexdigest(),
        "sourceQualified": True,
        "trafficAuthorized": False,
        "protectedPaths": protected,
    }


def qualify_source(sha: str) -> dict:
    """Read only the main-owned canonical record and immutable Git objects."""
    record, raw = _load_record()
    return _qualify(sha, record, raw)


def qualify_recorded_source() -> dict:
    record, raw = _load_record()
    return _qualify(record.get("sourceSha"), record, raw)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    arguments = parser.parse_args()
    try:
        print(json.dumps(qualify_source(arguments.sha)))
    except Refused as error:
        raise SystemExit(str(error)) from None
