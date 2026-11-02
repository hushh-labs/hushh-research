#!/usr/bin/env python3
"""Move running pods onto the hub's current image, one person or the whole fleet.

The operator's hand on the same path the reconcile worker sweeps automatically
(``PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED``). Use it when a fix has to reach a pod
NOW rather than on the next bounded pass, or from a hub that runs the sweep dark.

Runs INSIDE a hub environment: it needs the hub's registry (``DB_*``), the pod
image the hub ships (``HUSSH_ONE_POD_IMAGE``) and, for user-owned pods, the
consent-plane identity that may write into the person's registry. From a local
hybrid stack that is the worktree's ``.env`` plus the impersonated ADC file.

    uv run python scripts/ops/pod_upgrade.py --list
    uv run python scripts/ops/pod_upgrade.py --user-id <firebase uid>
    uv run python scripts/ops/pod_upgrade.py --all --limit 3
    uv run python scripts/ops/pod_upgrade.py --all --image gcr.io/.../consent-protocol-pod:dev-<sha>

``--image`` overrides the hub's own tag: it is how a pod is ROLLED BACK to a known
digest (the tag is resolved fresh, so name a tag that still exists).

Exit codes: 0 every requested pod ended on the target image (or was already there),
2 at least one upgrade failed OR was refused by the rollback guard (a pod that
reports memory tombstones never moves onto an image that predates them without
the exact ``--acknowledge-tombstone-rollback`` sentence), 3 nothing matched;
recovery exit 0 means verified or scheduled, not installed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except ImportError:
        return
    load_dotenv(env, override=False)


def _short(image: str | None) -> str:
    return (image or "-").rsplit("/", 1)[-1]


# -- the rollback guard -------------------------------------------------------------
#
# Memory schema 2 made a revocation a log record that hydration applies in order.
# An image built BEFORE it replays the same log and knows none of the new kinds:
# it skips them, so every revoked or superseded fact comes back as if the owner
# had never removed it. Rolling a pod that holds tombstones onto such an image is
# therefore not a rollback, it is an un-revocation, and the operator must say so
# in words before it happens. The count is read from the POD (its memory status),
# never from the registry row: only the running pod knows what its own log holds.

# The first commit whose image applies tombstones on hydration. It has to stay
# REACHABLE from this branch: git answers "not an ancestor" for a pin that was
# rewritten or never landed, so the probe below reports "predates" for every
# target, the guard refuses even a forward roll, and the operator learns to type
# the override. That is the failure this guard exists to prevent, so
# tests/test_pod_upgrade_rollback_guard.py asserts the pin against real history,
# and the lane that runs that suite checks the repository out at fetch-depth 0 so
# the assertion cannot quietly become a skip.
MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT = "4d27770023953c1ed684045592209fa1090df390"
ROLLBACK_ACKNOWLEDGEMENT = (
    "I understand this image predates memory tombstones and revoked facts may return"
)
EXIT_REFUSED = 2
_RECOVERY_INPUTS = (
    "operation_id",
    "target_image",
    "running_hub_source",
    "reviewed_executor_revision",
    "review_evidence_sha256",
)


def _image_sha(image: str) -> str | None:
    """The commit a pod image tag names (``…:dev-<sha>`` or ``…:<sha>``), if any."""
    tag = str(image or "").rsplit(":", 1)[-1].strip()
    if "-" in tag:
        tag = tag.rsplit("-", 1)[-1]
    return tag if len(tag) >= 7 and all(c in "0123456789abcdef" for c in tag.lower()) else None


def image_predates_tombstones(
    target_image: str,
    *,
    min_commit: str | None = None,
    repo_root: Path | None = None,
) -> bool | None:
    """True when ``target_image`` names a commit that is NOT a descendant of ``min_commit``.

    ``None`` when the tag carries no commit or git cannot answer: the caller
    treats unknown as predating, because an image nobody can place in history
    is not one to trust with an owner's revocations.
    """
    import subprocess  # noqa: PLC0415

    sha = _image_sha(target_image)
    if sha is None:
        return None
    try:
        probe = subprocess.run(  # noqa: S603 - fixed argv, validated hex sha
            [
                "git",
                "merge-base",
                "--is-ancestor",
                min_commit if min_commit is not None else MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT,
                sha,
            ],
            cwd=repo_root if repo_root is not None else ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if probe.returncode == 0:
        return False
    if probe.returncode == 1:
        return True
    return None


def placement_diagnostic(target_image: str, *, repo_root: Path | None = None) -> str:
    """Why ``image_predates_tombstones`` could not place an image, in one sentence.

    An unplaceable image refuses every pod. That is the safe direction, but on its
    own it is an opaque one: the operator sees REFUSED on a roll that moves strictly
    forward and cannot tell whether the image is genuinely old or whether this
    environment simply has nothing to compare it against. The concrete case is the
    deployed image, whose ``.dockerignore`` drops ``.git``, so the script shipped
    inside it has no history at all. Naming the cause keeps the refusal honest
    without softening it.
    """
    import subprocess  # noqa: PLC0415

    root = repo_root if repo_root is not None else ROOT
    if _image_sha(target_image) is None:
        return (
            f"the tag {_short(target_image)} names no commit, so it cannot be ordered "
            "against the tombstone floor; roll to a :dev-<sha> or :<sha> tag instead"
        )

    def run(*args: str) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(  # noqa: S603 - fixed argv
                ["git", *args],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None

    work_tree = run("rev-parse", "--is-inside-work-tree")
    if work_tree is None:
        return f"git is not runnable from {root}, so no image can be placed in history"
    if work_tree.returncode != 0:
        return (
            f"{root} is not a git work tree, so no image can be placed in history; "
            "the deployed image ships no .git, so run this from a hub checkout"
        )
    shallow = run("rev-parse", "--is-shallow-repository")
    if shallow is not None and shallow.stdout.strip() == "true":
        return (
            f"{root} is a shallow clone, so the tombstone floor is not in its history; "
            "fetch full history before rolling"
        )
    return (
        f"git in {root} cannot place {_short(target_image)}: neither it nor the "
        "tombstone floor is in a history this checkout can see"
    )


async def pod_tombstone_count(row: dict, *, reader: object | None = None) -> int | None:
    """How many tombstones the POD reports, via its own memory status. None when unknown."""
    read = reader
    if read is None:
        read = _read_pod_memory_status
    try:
        status = await read(row)  # type: ignore[operator]
    except Exception as exc:  # noqa: BLE001 - unknown is reported, never guessed at
        print(f"  tombstone count unavailable for {row.get('hushh_id')}: {type(exc).__name__}")
        return None
    if not isinstance(status, dict):
        return None
    value = status.get("tombstones")
    return int(value) if isinstance(value, int) else None


async def _read_pod_memory_status(row: dict) -> dict:
    """GET the pod's ``/api/one/pod/memory/status`` as the hub, with the owner's grant."""
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
        PersonalAgentGrantService,
    )

    metadata = row.get("backend_metadata") or {}
    url = str(metadata.get("url") or "").rstrip("/")
    if not url.startswith("https://"):
        raise RuntimeError("pod url unavailable")
    grant = await PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(
        str(row.get("user_id") or "")
    )
    response = requests.get(
        f"{url}/api/one/pod/memory/status",
        headers={
            "Authorization": f"Bearer {mint_operator_id_token(url)}",
            "X-Consent-Token": str(grant.get("token") or ""),
        },
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise RuntimeError(f"memory status HTTP {response.status_code}")
    return dict(response.json() or {})


def rollback_refusal(
    *, tombstones: int | None, predates: bool | None, acknowledgement: str | None
) -> str | None:
    """The sentence that refuses this upgrade, or None when it may proceed.

    Refuses when the pod reports tombstones (or the count is unknown) and the
    target predates the tombstone-aware commit (or cannot be placed), unless the
    operator typed the exact acknowledgement.
    """
    if predates is False:
        return None
    if tombstones == 0:
        return None
    if acknowledgement == ROLLBACK_ACKNOWLEDGEMENT:
        return None
    held = "an unknown number of" if tombstones is None else str(tombstones)
    placement = "cannot be placed relative to" if predates is None else "predates"
    return (
        f"refused: the pod reports {held} memory tombstone(s) and the target image "
        f"{placement} the tombstone-aware commit {MEMORY_TOMBSTONE_MIN_IMAGE_COMMIT[:12]}; "
        "moving it would resurrect revoked facts. Re-run with "
        f'--acknowledge-tombstone-rollback "{ROLLBACK_ACKNOWLEDGEMENT}" to override.'
    )


async def _main(args: argparse.Namespace) -> int:
    if getattr(args, "recover_notification_upgrade", False):
        return await _recover_notification_upgrade(args)

    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
        running_image,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    target = str(args.image or os.environ.get("HUSSH_ONE_POD_IMAGE") or "").strip()
    if not target:
        print("no target image: set HUSSH_ONE_POD_IMAGE or pass --image", file=sys.stderr)
        return 3

    registry = PersonalAgentRegistryRepo()
    service = PersonalAgentProvisioningService(registry=registry, backend=resolve_compute_backend())

    if args.user_id:
        row = await registry.get(args.user_id)
        rows = [row] if row else []
    else:
        rows = await service.list_upgrade_candidates(current_image=target, limit=args.limit)

    if not rows:
        print(f"nothing to upgrade against {_short(target)}")
        return 3

    print(f"target image: {target}")
    for row in rows:
        print(
            f"  {str(row.get('hushh_id') or '-')[:40]:40}  status={row.get('status') or '-':12}  "
            f"built_from={_short(running_image(row))}"
        )
    if args.list or args.dry_run:
        return 0

    # The rollback guard runs ONCE per target, before any pod moves: if the target
    # predates the tombstone-aware commit, every pod holding tombstones is refused
    # unless the operator typed the acknowledgement. The sweep never needs this:
    # it only moves forward onto the hub's current image.
    predates = image_predates_tombstones(target)
    if predates is None:
        print(f"  unplaceable target: {placement_diagnostic(target)}")
    acknowledgement = getattr(args, "acknowledge_tombstone_rollback", None)

    failed = 0
    for row in rows[: args.limit]:
        user_id = str(row.get("user_id") or "")
        if predates is not False:
            tombstones = await pod_tombstone_count(row)
            refusal = rollback_refusal(
                tombstones=tombstones, predates=predates, acknowledgement=acknowledgement
            )
            if refusal:
                failed += 1
                print(f"REFUSED {row.get('hushh_id')}: {refusal}")
                continue
        try:
            result = await service.upgrade_pod(user_id=user_id, current_image=target)
        except Exception as exc:  # noqa: BLE001 - reported per pod, never aborts the batch
            failed += 1
            print(f"FAILED  {row.get('hushh_id')}: {type(exc).__name__}: {str(exc)[:200]}")
            continue
        verb = "upgraded" if result.get("upgraded") else "already current"
        print(
            f"{verb:16} {result.get('hushhId')}  {_short(result.get('previousImage'))} -> {_short(result.get('image'))}"
        )
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
    return 2 if failed else 0


def _notification_recovery_readers(registry, cloud, row):
    from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    if not cloud.bootstrap_sa:
        raise RuntimeError("owner bootstrap identity unavailable")
    backend = UserGcpBackend(
        user_project=cloud.project,
        user_region=cloud.region,
        bootstrap_sa=cloud.bootstrap_sa,
        hushh_id=str(row.get("hushh_id") or ""),
        live=True,
    )
    run = None

    async def event_reader(candidate):
        sql = (
            "SELECT user_id,hushh_id,seq,attempt,event,stage,registry_status,occurred_at,reason "
            "FROM pod_lifecycle_events WHERE user_id=:user_id AND hushh_id=:hushh_id AND "
            "occurred_at>=:attempted_at ORDER BY occurred_at DESC,seq DESC LIMIT 64"
        )
        result = await asyncio.to_thread(
            registry._db().execute_raw,
            sql,
            {
                "user_id": candidate.user_id,
                "hushh_id": candidate.hushh_id,
                "attempted_at": candidate.attempted_at.isoformat(),
            },
        )
        return list(result.data or [])

    async def native_reader(candidate):
        nonlocal run
        if run is None:
            run = await asyncio.to_thread(backend._client)
        return await asyncio.to_thread(run.get_service, candidate.service_name)

    async def handoff_reader(candidate, native):
        client = PodUpgradeHandoffClient(
            url=str(native.get("podUrl") or ""), hushh_id=candidate.hushh_id
        )
        return await asyncio.to_thread(client.recovery_snapshot)

    return event_reader, native_reader, handoff_reader


async def _owner_notification_recovery_readers(registry, user_id, row):
    from hushh_mcp.services.gcp_notification_upgrade_recovery import (
        NotificationUpgradeRecoveryRefused,
    )
    from hushh_mcp.services.user_cloud_service import resolve_user_cloud

    cloud = await resolve_user_cloud(user_id, repo=registry, registry_row=row)
    if cloud is None or not cloud.is_ready_to_provision or not cloud.project or not cloud.region:
        raise NotificationUpgradeRecoveryRefused("owner's recorded GCP project is not authorized")
    return _notification_recovery_readers(registry, cloud, row)


async def _recover_notification_upgrade(args: argparse.Namespace) -> int:
    from hushh_mcp.services.gcp_notification_upgrade_recovery import (
        NotificationUpgradeRecoveryRefused,
        recover_blocked_upgrade,
        validate_notification_admission,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    try:
        running_source = str(args.running_hub_source or "").strip().lower()
        if (
            not running_source
            or os.environ.get("HUSHH_DEPLOY_SHA", "").strip().lower() != running_source
            or args.target_image != os.environ.get("HUSSH_ONE_POD_IMAGE", "").strip()
        ):
            raise NotificationUpgradeRecoveryRefused("runtime source/target mismatch")

        registry = PersonalAgentRegistryRepo()
        row = await registry.get(args.user_id)
        if row is None:
            raise NotificationUpgradeRecoveryRefused("owner registry row unavailable")

        event_reader, native_reader, handoff_reader = await _owner_notification_recovery_readers(
            registry, args.user_id, row
        )
        result = await recover_blocked_upgrade(
            user_id=args.user_id,
            row=row,
            target_image=args.target_image,
            running_hub_source=running_source,
            reviewed_operation_id=args.operation_id,
            reviewed_executor_revision=args.reviewed_executor_revision,
            review_evidence_sha256=args.review_evidence_sha256,
            event_reader=event_reader,
            native_reader=native_reader,
            handoff_reader=handoff_reader,
            notification_validator=lambda: validate_notification_admission(registry),
            writer=registry.record_image_upgrade,
            execute=bool(args.execute),
        )

        if result.get("status") == "dry_run":
            print("DRY RUN VERIFIED: no registry write; add --execute to schedule recovery")
            return 0
        if result.get("status") == "scheduled":
            print("SCHEDULED: owner operation re-armed; normal reconcile will perform later work")
            return 0
        print("RECOVERY FAILED: unexpected result state", file=sys.stderr)
        return EXIT_REFUSED

    except Exception as exc:  # noqa: BLE001 - no provider or database details escape
        if isinstance(exc, NotificationUpgradeRecoveryRefused):
            print(f"REFUSED: {exc}", file=sys.stderr)
        else:
            print(f"RECOVERY FAILED: {type(exc).__name__}", file=sys.stderr)
        return EXIT_REFUSED


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--user-id", help="one person's Firebase uid")
    who.add_argument("--all", action="store_true", help="every stale provisioned pod")
    who.add_argument("--list", action="store_true", help="show stale pods and exit")
    ap.add_argument("--image", help="target image (default: the hub's HUSSH_ONE_POD_IMAGE)")
    ap.add_argument("--limit", type=int, default=3, help="max pods to move in this run")
    ap.add_argument("--recover-notification-upgrade", action="store_true")
    ap.add_argument("--operation-id", help="reviewed owner operation ID for recovery")
    ap.add_argument("--target-image", help="explicit immutable target image for recovery")
    ap.add_argument("--running-hub-source", help="current source SHA, matched to HUSHH_DEPLOY_SHA")
    ap.add_argument("--reviewed-executor-revision", help="full reviewed failed executor revision")
    ap.add_argument("--review-evidence-sha256", help="public provenance artifact SHA-256")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--acknowledge-tombstone-rollback",
        metavar="SENTENCE",
        help=(
            "required, verbatim, to move a pod that reports memory tombstones onto an "
            f"image that predates them: {ROLLBACK_ACKNOWLEDGEMENT!r}"
        ),
    )
    args = ap.parse_args()
    if args.recover_notification_upgrade:
        invalid = (
            not args.user_id
            or args.image
            or args.acknowledge_tombstone_rollback
            or (args.execute and args.dry_run)
            or any(not getattr(args, key) for key in _RECOVERY_INPUTS)
        )
        if invalid:
            ap.error(
                "Recovery requires one owner and all review inputs; normal-upgrader flags are forbidden"
            )
    elif args.execute or any(getattr(args, key) for key in _RECOVERY_INPUTS):
        ap.error("recovery inputs require --recover-notification-upgrade")
    _load_env()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
