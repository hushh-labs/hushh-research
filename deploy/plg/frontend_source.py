"""Qualify one immutable PLG frontend source without granting release authority.

Execute this module and its record from the trusted Main authority checkout;
the application checkout supplies Git objects only, never qualification code.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path


def _load_backend_source():
    spec = importlib.util.spec_from_file_location(
        "plg_backend_source_authority", Path(__file__).with_name("release_source.py")
    )
    if not spec or not spec.loader:
        raise RuntimeError("PLG backend source authority unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backend = _load_backend_source()
Refused = backend.Refused
require = backend.require
RECORD = Path(__file__).with_name("frontend-source.json")
BASELINE_SHA = "5de6ee29abe3b00642bd6b745c608279091810b3"
PRODUCTION_BASELINE_SHA = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
SOURCE_SHA = "2a860818549f2d6c16d1f98bd8fb9cebe01a1f84"
BASELINE_TREE = "70000fabb2cef2d38d2b8dd643b591e9b50b44eb"
SOURCE_TREE = "c439140f2a6c34b9e76243baf6f5d4eb66eeae50"
MAX_BLOB_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024

# These exact paths and modes are an authority boundary, not record-supplied
# policy. Changes to dependencies, authentication, native controls, backend
# code, release tooling, compiler inputs or other product surfaces fail closed.
ALLOWED_CHANGES = {
    "contracts/architecture/runtime-topology-index.v1.json": "M",
    "docs/reference/architecture/api-contracts.md": "M",
    "hushh-webapp/__tests__/api/plg-email-unsubscribe.test.ts": "A",
    "hushh-webapp/__tests__/components/marketing-preference.test.tsx": "M",
    "hushh-webapp/__tests__/services/observability-growth.test.ts": "M",
    "hushh-webapp/__tests__/services/post-auth-route-service.test.ts": "M",
    "hushh-webapp/app/api/_utils/plg-email-unsubscribe.ts": "A",
    "hushh-webapp/app/api/plg-email/unsubscribe/[token]/route.ts": "A",
    "hushh-webapp/components/account/marketing-preference-panel.tsx": "M",
    "hushh-webapp/components/profile/profile-workspace-page.tsx": "M",
    "hushh-webapp/contracts/ui-review/back/525467f86a142d1f81b707b1d0f094c9dbffc752805c3bbc181f7c185cab24b6.json": "A",
    "hushh-webapp/contracts/ui-review/back/e380bd311325bdcffaa2adeede22fe0129ce800d1c5822aaee2d2739d5771a8e.json": "A",
    "hushh-webapp/contracts/ui-review/search/6269be30d154d9932695bf1a90a8adfa989b4df74e34e16fb9c52cfe2ce55146.json": "A",
    "hushh-webapp/frontend-native-surface-map.generated.json": "M",
    "hushh-webapp/lib/navigation/routes.ts": "M",
    "hushh-webapp/lib/observability/growth.ts": "M",
    "hushh-webapp/lib/observability/log-redactor.ts": "M",
    "hushh-webapp/lib/observability/route-map.ts": "M",
    "hushh-webapp/next.config.ts": "M",
}

PROTECTED_PATHS = (
    "consent-protocol",
    "deploy",
    ".github",
    "hushh-webapp/lib/auth",
    "hushh-webapp/android",
    "hushh-webapp/ios",
    "hushh-webapp/package.json",
    "hushh-webapp/package-lock.json",
    "hushh-webapp/contracts/kai",
    "contracts/kai",
)
FIXED_RECORD = {
    "schemaVersion": 1,
    "kind": "plg-frontend-source-v1",
    "sourceSha": SOURCE_SHA,
    "baselineSha": BASELINE_SHA,
    "productionBaselineSha": PRODUCTION_BASELINE_SHA,
    "sourceTree": SOURCE_TREE,
    "baselineTree": BASELINE_TREE,
    "project": "hushh-pda",
    "region": "us-central1",
    "scope": "frontend",
    "services": ["hushh-webapp"],
    "migrations": "none",
    "replacementAccounts": 0,
}


def _load_record() -> tuple[dict, bytes]:
    try:
        with RECORD.open("rb") as source:
            raw = source.read(MAX_RECORD_BYTES + 1)
        require(
            len(raw) <= MAX_RECORD_BYTES, "PLG frontend source record exceeds its bound"
        )
        record = json.loads(raw, object_pairs_hook=backend._json_pairs)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise Refused("Canonical PLG frontend source record unavailable") from None
    require(isinstance(record, dict), "Invalid PLG frontend source record")
    return record, raw


def _check_record(sha: str, record: dict) -> None:
    require(
        isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) is not None,
        "Exact PLG frontend source SHA required",
    )
    require(
        set(record) == set(FIXED_RECORD) | {"changes"}
        and all(record[key] == value for key, value in FIXED_RECORD.items()),
        "PLG frontend source record or fixed boundary changed",
    )
    require(
        type(record["schemaVersion"]) is int
        and type(record["replacementAccounts"]) is int
        and sha == SOURCE_SHA,
        "Source is not the recorded PLG frontend candidate",
    )


def _entry(sha: str, path: str) -> dict | None:
    raw = backend._git("ls-tree", "-z", sha, "--", f":(literal){path}")
    if not raw:
        return None
    try:
        rows = raw.split(b"\0")
        require(len(rows) == 2 and rows[-1] == b"", "Ambiguous frontend tree entry")
        metadata, actual = rows[0].split(b"\t", 1)
        mode, kind, blob = metadata.decode().split()
        require(actual.decode() == path, "Frontend tree path changed")
    except (ValueError, UnicodeError):
        raise Refused("Invalid frontend tree entry") from None
    require(
        mode == "100644" and kind == "blob" and re.fullmatch(r"[0-9a-f]{40}", blob),
        "Frontend source file mode or object type changed",
    )
    try:
        size = int(backend._git("cat-file", "-s", f"{sha}:{path}").strip())
    except ValueError:
        raise Refused("Frontend source blob size is invalid") from None
    require(0 <= size <= MAX_BLOB_BYTES, "Frontend source blob exceeds its bound")
    content = backend._git("show", f"{sha}:{path}")
    require(len(content) == size, "Frontend source blob size changed")
    return {"blob": blob, "sha256": hashlib.sha256(content).hexdigest()}


def _check_changes(sha: str, rows: object) -> None:
    require(
        isinstance(rows, list) and len(rows) == len(ALLOWED_CHANGES),
        "PLG frontend change inventory changed",
    )
    observed = {}
    for row in rows:
        require(
            isinstance(row, dict) and set(row) == {"path", "status", "before", "after"},
            "Invalid PLG frontend change record",
        )
        path = row["path"]
        require(
            isinstance(path, str) and path in ALLOWED_CHANGES and path not in observed,
            "Unreviewed PLG frontend source path",
        )
        status = ALLOWED_CHANGES[path]
        require(row["status"] == status, "PLG frontend source status changed")
        before, after = _entry(BASELINE_SHA, path), _entry(sha, path)
        require(
            after is not None and (before is None) == (status == "A"),
            "PLG frontend source presence changed",
        )
        require(
            row["before"] == before and row["after"] == after,
            "PLG frontend source blob or SHA256 changed",
        )
        observed[path] = status
    raw = backend._git(
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
        raw[-1] == b"" and len(raw) == 2 * len(ALLOWED_CHANGES) + 1,
        "Unreviewed changes outside the PLG frontend patch",
    )
    try:
        actual = {
            raw[i + 1].decode(): raw[i].decode() for i in range(0, len(raw) - 1, 2)
        }
    except UnicodeError:
        raise Refused("Invalid PLG frontend change path") from None
    require(actual == ALLOWED_CHANGES == observed, "Unreviewed PLG frontend change")


def _check_trees(sha: str) -> dict:
    for commit, expected in ((BASELINE_SHA, BASELINE_TREE), (sha, SOURCE_TREE)):
        require(
            backend._git("rev-parse", f"{commit}^{{tree}}").strip().decode()
            == expected,
            "PLG frontend source tree changed",
        )
    backend._git("merge-base", "--is-ancestor", BASELINE_SHA, sha)
    protected = {}
    for path in PROTECTED_PATHS:
        before, after = backend._object(BASELINE_SHA, path), backend._object(sha, path)
        require(
            before is not None and before == after,
            "Protected frontend predecessor changed",
        )
        protected[path] = before[2]
    return protected


def qualify_source(sha: str) -> dict:
    """Read the trusted record and Git objects; this never admits deployment."""
    record, raw = _load_record()
    _check_record(sha, record)
    predecessor = backend.qualify_source(BASELINE_SHA)
    require(
        isinstance(predecessor, dict)
        and predecessor.get("sourceSha") == BASELINE_SHA
        and predecessor.get("frontendSha") == PRODUCTION_BASELINE_SHA
        and predecessor.get("sourceQualified") is True
        and predecessor.get("trafficAuthorized") is False
        and isinstance(predecessor.get("recordSha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", predecessor["recordSha256"]) is not None,
        "The pinned backend source predecessor is not qualified",
    )
    protected = _check_trees(sha)
    _check_changes(sha, record["changes"])
    return {
        **record,
        "recordSha256": hashlib.sha256(raw).hexdigest(),
        "backendRecordSha256": predecessor["recordSha256"],
        "sourceQualified": True,
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
        "protectedPaths": protected,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(qualify_source(args.sha)))
    except Refused as error:
        raise SystemExit(str(error)) from None
