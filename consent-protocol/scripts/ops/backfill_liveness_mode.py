"""Re-stamp ``personal_agent_registry.liveness_mode`` from what each pod really is.

Read-only by default. Nothing is written without ``--apply``.

Why this exists
---------------
``liveness_mode`` decides how a pod's SILENCE is read. ``economy`` means the pod is
allowed to be scaled to zero, so silence is "asleep" and the sweep leaves it alone.
``warm`` means a warm floor was paid for, so silence is a FAULT and the sweep probes
the pod awake -- which costs a cold start on every pass.

A row that says ``warm`` about a pod running at ``minScale=0`` therefore bills its
owner, forever, to check on a pod that was working the whole time. Three ways a row
ends up in that state, all observed:

1. **Pre-905 rows.** The column was added with a default of ``warm``, so every row
   that existed before it claims a warm floor nobody ever bought.
2. **Rows written before the handle carried the mode.** The first live pods --
   including the first BYOC pod -- were recorded with no ``livenessMode`` in their
   backend metadata, so they inherited the same default.
3. **Adopted pods.** ``discover`` computed the mode from the live service and
   ``adopt_orphan`` dropped it on the floor. Fixed at the source in the same change
   as this script; this handles the rows already written.

The durable half is the fix in ``adopt_orphan`` and the mode being pinned from the
handle at provision time. This script is for the backlog those two cannot reach,
because a row that is already wrong is never re-provisioned.

How the mode is decided
-----------------------
Not guessed, and not read from the environment: the LIVE service is fetched and the
same two shipped functions the provisioner uses -- ``_rendered_min_scale`` and
``_liveness_mode`` -- are applied to it. If a fleet-wide default changes tomorrow,
this script keeps agreeing with the code that provisions pods, because it is the
same code.

Credentials
-----------
Managed pods are read with the operator key, exactly as ``pod_fleet.py`` does.
BYOC pods live in a project hushh holds no standing identity in, so each is read by
minting a bootstrap token FROM THAT ROW -- the same credential path the hub uses to
serve that person. A row whose pod cannot be read is SKIPPED LOUDLY and counted; it
is never silently defaulted, because a silent default is how the wrong answers got
into these rows in the first place.

Usage::

    uv run python scripts/ops/backfill_liveness_mode.py                  # report only
    uv run python scripts/ops/backfill_liveness_mode.py --apply          # write
    uv run python scripts/ops/backfill_liveness_mode.py --user-id <uid>  # one person
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.gcp_backend import _liveness_mode, _rendered_min_scale  # noqa: E402

_VALID = ("warm", "economy")


def _operator_session():
    """A session signed by hushh's own operator key -- managed pods only."""
    from google.auth.transport.requests import AuthorizedSession

    from hushh_mcp.services.gcp_run_client import load_operator_credentials

    return AuthorizedSession(load_operator_credentials())


def _bootstrap_session(bootstrap_sa: str):
    """A session carrying a token minted BY IMPERSONATING the person's bootstrap SA.

    `mint_bootstrap_token` returns a bare access-token string rather than a
    credentials object, so this is a plain session with an Authorization header --
    not `AuthorizedSession`, which expects credentials and would refuse a string.

    This is the same keyless path the hub uses to serve that person, and it fails
    loudly if their grant was revoked. That is the correct behaviour here too: a
    row whose project hushh can no longer reach must be reported as unreadable,
    never quietly stamped from a fallback identity.
    """
    import requests

    from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {mint_bootstrap_token(bootstrap_sa=bootstrap_sa)}"
    return session


def _service_url(project: str, region: str, service: str) -> str:
    return (
        f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1"
        f"/namespaces/{project}/services/{service}"
    )


def _row_coordinates(row: dict[str, Any]) -> tuple[str, str, str]:
    """Where this row's pod actually lives, from the row rather than the environment."""
    metadata = dict(row.get("backend_metadata") or {})
    project = str(metadata.get("project") or row.get("user_cloud_project") or "").strip()
    region = str(metadata.get("region") or row.get("user_cloud_region") or "us-central1").strip()
    service = str(metadata.get("service") or row.get("external_agent_id") or "").strip()
    return project, region, service


def _read_service(row: dict[str, Any]) -> tuple[Optional[dict[str, Any]], str]:
    """Fetch the live Cloud Run service for one row. Returns (service, note)."""
    project, region, service = _row_coordinates(row)
    if not project or not service:
        return None, "no recorded host (project/service missing)"

    is_user_owned = str(row.get("deployment_target") or "").strip() == "user_gcp"
    try:
        if is_user_owned:
            bootstrap_sa = str(row.get("user_cloud_bootstrap_sa") or "").strip()
            if not bootstrap_sa:
                return None, "user-owned row with no bootstrap account recorded"
            session = _bootstrap_session(bootstrap_sa)
        else:
            session = _operator_session()
    except Exception as exc:  # noqa: BLE001 - an unreadable pod is reported, never assumed
        return None, f"credential unavailable: {type(exc).__name__}"

    try:
        response = session.get(_service_url(project, region, service), timeout=60)
    except Exception as exc:  # noqa: BLE001
        return None, f"service unreachable: {type(exc).__name__}"
    if response.status_code == 404:
        return None, "service does not exist (reaped or never created)"
    if not response.ok:
        return None, f"http {response.status_code}"
    return response.json(), ""


def _observed_mode(service: dict[str, Any]) -> str:
    """The mode this pod IS, via the exact functions that decide it at provision."""
    template = ((service.get("spec") or {}).get("template") or {}) or {}
    # `_rendered_min_scale` reads the same annotation shape the renderer writes, so
    # the deployed config is handed to it verbatim rather than re-parsed here.
    return str(_liveness_mode(_rendered_min_scale({"spec": {"template": template}})))


async def _load_rows(user_id: Optional[str], *, limit: int) -> list[dict[str, Any]]:
    """The rows that own (or are standing up) a host.

    ``fetch_liveness_candidates`` is the existing reader for exactly this set, and
    it deliberately applies no policy -- it returns candidates and lets the caller
    judge, which is why it is the right query here rather than a new one.
    """
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()
    if user_id:
        row = await repo.get(user_id)
        return [row] if row else []
    return list(await repo.fetch_liveness_candidates(limit=limit))


async def _run(args: argparse.Namespace) -> int:
    rows = await _load_rows(args.user_id, limit=args.limit)
    if not rows:
        print("no registry rows found")
        return 0

    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    repo = PersonalAgentRegistryRepo()

    agreed = 0
    corrected: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for row in rows:
        user_id = str(row.get("user_id") or "")
        recorded = str(row.get("liveness_mode") or "").strip() or "(unset)"
        service_doc, note = _read_service(row)
        if service_doc is None:
            # LOUD, not silent. A pod we could not read is an open question, and
            # recording a default for it would be inventing an answer.
            skipped.append({"user_id": user_id, "recorded": recorded, "why": note})
            continue

        observed = _observed_mode(service_doc)
        if observed not in _VALID:
            skipped.append(
                {"user_id": user_id, "recorded": recorded, "why": f"unusable mode {observed!r}"}
            )
            continue
        if observed == recorded:
            agreed += 1
            continue

        corrected.append({"user_id": user_id, "from": recorded, "to": observed})
        if args.apply:
            await repo.set_liveness_mode(user_id=user_id, liveness_mode=observed)

    verb = "corrected" if args.apply else "would correct"
    print(
        f"scanned {len(rows)} row(s): {agreed} already agreed, {len(corrected)} {verb}, "
        f"{len(skipped)} skipped"
    )
    for entry in corrected:
        print(f"  {verb}: {entry['user_id']}  {entry['from']} -> {entry['to']}")
    for entry in skipped:
        print(f"  SKIPPED {entry['user_id']} (recorded {entry['recorded']}): {entry['why']}")
    if skipped:
        print(
            "\nSkipped rows keep whatever they had. That is deliberate: a pod nobody "
            "could read is an open question, and defaulting it is how these rows got "
            "wrong in the first place."
        )
    if corrected and not args.apply:
        print("\nnothing was written. Re-run with --apply to write these corrections.")
    if args.json:
        print(json.dumps({"corrected": corrected, "skipped": skipped, "agreed": agreed}, indent=2))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--user-id", default=None, help="restrict to one person's row")
    ap.add_argument("--apply", action="store_true", help="write the corrections")
    ap.add_argument("--json", action="store_true", help="also emit a JSON summary")
    ap.add_argument("--limit", type=int, default=500, help="max rows to scan")
    args = ap.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
