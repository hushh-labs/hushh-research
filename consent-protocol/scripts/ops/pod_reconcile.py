#!/usr/bin/env python3
"""Fleet-first orphan reconciliation -- REPORT ONLY.

The one check that catches a billing Cloud Run pod with NO registry row. Every
other reconciler is registry-first and so is blind to a live service that has no
row at all (a pod that outlived its account delete). This enumerates the live
fleet and outer-joins complete registry host claims on recorded cloud coordinates.

    uv run python scripts/ops/pod_reconcile.py --project hushh-pda-dev --region us-central1

Deletes NOTHING. It names the two abandonment directions and stops. Reclaiming a
Direction-B orphan (deleting billing compute in a possibly customer-owned project)
is founder-gated behind PERSONAL_AGENT_FLEET_RECLAIM_ENABLED and is never done here.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from hushh_mcp.services.pod_reconcile import classify_fleet_registry_mismatch

POD_LABEL = "app=hussh-one-pod"


def _fleet_service_names(project: str, region: str) -> list[str]:
    # Route through GcpRunClient.list_services rather than a hand-rolled GET so a 403
    # (an identity that cannot list the project's services) SURFACES as an error rather
    # than an empty list -- a report that shows a project swept-clean when it was merely
    # unreadable would send an operator hunting for orphans that were never gone (R8).
    from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

    items = GcpRunClient(project=project, region=region).list_services(POD_LABEL)
    return [str((svc.get("metadata") or {}).get("name") or "") for svc in items]


async def _registry_rows() -> list[dict]:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    return await PersonalAgentRegistryRepo().fetch_fleet_inventory()


def _verify_build_source(build: dict, *, checkout: str, token: str, session) -> dict:
    """Compare a pinned upload and submitted recipe with local Git, without extraction.

    This verifies uploaded source provenance, not recipe safety, reproducibility,
    dependency contents, or whether omitted files affect application behavior.
    """
    import base64
    import hashlib
    import io
    import re
    import subprocess
    import tarfile
    from urllib.parse import quote

    import yaml

    from hushh_mcp.services.pod_image_copy import ImageCopyError

    commit = (build.get("substitutions") or {}).get("_DEPLOY_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ImageCopyError("source revision invalid")

    def git(*args):
        return subprocess.check_output(  # noqa: S603 -- fixed git operations and validated revision; no shell
            ["git", "-C", checkout, *args], stderr=subprocess.PIPE, timeout=30
        )

    if git("rev-parse", f"{commit}^{{commit}}").decode().strip() != commit:
        raise ImageCopyError("source revision unavailable")
    source = (build.get("sourceProvenance") or {}).get("resolvedStorageSource") or {}
    bucket, object_name, generation = (
        source.get(key, "") for key in ("bucket", "object", "generation")
    )
    if (
        not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket)
        or not re.fullmatch(r"[0-9]+", str(generation))
        or not isinstance(object_name, str)
        or not 1 <= len(object_name) <= 1024
    ):
        raise ImageCopyError("pinned source archive unavailable")
    source_name = f"gs://{bucket}/{object_name}#{generation}"
    hashes = (
        ((build.get("sourceProvenance") or {}).get("fileHashes") or {})
        .get(source_name, {})
        .get("fileHash", [])
    )
    sha = [base64.b64decode(h["value"], validate=True) for h in hashes if h.get("type") == "SHA256"]
    if len(sha) != 1 or len(sha[0]) != 32:
        raise ImageCopyError("source archive digest unavailable")
    response = session.get(
        f"https://storage.googleapis.com/download/storage/v1/b/{quote(bucket, safe='')}/o/{quote(object_name, safe='')}",
        params={"alt": "media", "generation": str(generation)},
        headers={"Authorization": f"Bearer {token}"},
        timeout=45,
        stream=True,
        allow_redirects=False,
    )
    try:
        if response.status_code != 200:
            raise ImageCopyError("source archive unavailable")
        raw = bytearray()
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            raw.extend(chunk)
            if len(raw) > 64 * 1024 * 1024:
                raise ImageCopyError("source archive exceeds comparison limit")
    finally:
        response.close()
    if hashlib.sha256(raw).digest() != sha[0]:
        raise ImageCopyError("source archive digest mismatch")
    tree = {}
    for line in git("ls-tree", "-rz", commit).split(b"\0"):
        if line:
            metadata, name = line.split(b"\t", 1)
            mode, kind, blob = metadata.decode().split()
            if kind == "blob":
                tree[name.decode()] = (mode, blob)
    seen = set()
    extras = []
    inventory = []
    expanded_size = 0
    entry_count = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            entry_count += 1
            if entry_count > 40000:
                raise ImageCopyError("source archive entry limit exceeded")
            if member.isdir():
                continue
            name = member.name.removeprefix("./")
            if (
                name in seen
                or name.startswith("/")
                or ".." in name.split("/")
                or not member.isfile()
            ):
                # No links are needed in the verified current context; refuse
                # before a link can introduce information outside the archive.
                raise ImageCopyError("source archive entry unsupported")
            seen.add(name)
            expanded_size += member.size
            if (
                len(seen) > 20000
                or member.size > 32 * 1024 * 1024
                or expanded_size > 256 * 1024 * 1024
            ):
                raise ImageCopyError("source archive inventory limit exceeded")
            content = archive.extractfile(member).read()
            blob = hashlib.sha1(
                b"blob " + str(len(content)).encode() + b"\0" + content, usedforsecurity=False
            ).hexdigest()
            mode = "100755" if member.mode & 0o111 else "100644"
            if name in tree and tree[name] != (mode, blob):
                raise ImageCopyError("uploaded source differs from revision")
            if name not in tree:
                extras.append(name)
            inventory.append(
                {"path": name, "mode": mode, "sha256": hashlib.sha256(content).hexdigest()}
            )
    recipe = yaml.safe_load(git("show", f"{commit}:deploy/backend.cloudbuild.yaml"))
    values = {
        **build.get("substitutions", {}),
        "PROJECT_ID": build["projectId"],
        "BUILD_ID": build["id"],
    }

    def expand(value):
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        if not isinstance(value, str):
            return value
        value = value.replace("$$", "\0")
        return re.sub(
            r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)",
            lambda m: values.get(m[1] or m[2], m[0]),
            value,
        ).replace("\0", "$")

    if len(recipe["steps"]) != len(build["steps"]):
        raise ImageCopyError("submitted build adds or removes recipe steps")
    for key in ("secrets", "availableSecrets"):
        if build.get(key) != expand(recipe.get(key)):
            raise ImageCopyError("submitted build secret inputs differ from recipe")
    for key in ("env", "secretEnv", "volumes"):
        if (build.get("options") or {}).get(key) != expand((recipe.get("options") or {}).get(key)):
            raise ImageCopyError("submitted build execution options differ from recipe")
    if bool((build.get("options") or {}).get("automapSubstitutions", False)) != bool(
        (recipe.get("options") or {}).get("automapSubstitutions", False)
    ):
        raise ImageCopyError("submitted build substitution environment differs from recipe")
    checked_steps = []
    for index, step in enumerate(recipe["steps"]):
        expected, actual = expand(step), build["steps"][index]
        if set(actual) - set(expected) - {"status", "timing", "pullTiming", "exitCode"}:
            raise ImageCopyError("submitted recipe has additional execution fields")
        if (
            any(actual.get(key) != value for key, value in expected.items())
            or actual.get("status") != "SUCCESS"
        ):
            raise ImageCopyError("submitted recipe differs from revision")
        checked_steps.append(step.get("id"))
    if "build-pod-image" not in checked_steps:
        raise ImageCopyError("source recipe has no pod image")
    return {
        "revision": commit,
        "sourceArchive": {"bucket": bucket, "object": object_name, "generation": str(generation)},
        "archiveSha256": sha[0].hex(),
        "uploadedInventorySha256": hashlib.sha256(
            json.dumps(
                sorted(inventory, key=lambda item: item["path"]),
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
        "uploadedTrackedFiles": len(seen) - len(extras),
        "extraPaths": sorted(extras),
        "omittedPaths": sorted(set(tree) - seen),
        "matchedRecipeSteps": checked_steps,
        "uploadedTrackedSourceMatches": True,
        "recipeMatches": True,
        "completeGitTree": not extras and seen == set(tree),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet-first orphan reconciliation (report only).")
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument(
        "--repository-created-at",
        help="read-only one-pod image inventory; require the retained repository creation timestamp",
    )
    ap.add_argument(
        "--source-image",
        help="compare observed image manifests to this declared application source; requires --repository-created-at",
    )
    ap.add_argument(
        "--build-id",
        action="append",
        default=[],
        help="successful source pod build to verify; repeat for historical versions",
    )
    ap.add_argument("--build-location", default="global")
    ap.add_argument(
        "--verify-source",
        action="store_true",
        help="compare pinned build uploads and recipes with this checkout Git history",
    )
    args = ap.parse_args()
    if args.verify_source and not args.build_id:
        ap.error("--verify-source requires --build-id")
    if args.build_id and not args.source_image:
        ap.error("--build-id requires --source-image")
    if args.source_image and not args.repository_created_at:
        ap.error("--source-image requires --repository-created-at")
    if args.repository_created_at:
        import requests
        from google.auth.transport.requests import Request

        from hushh_mcp.services.gcp_run_client import load_operator_credentials
        from hushh_mcp.services.pod_image_copy import (
            compare_repository_build_outputs,
            compare_repository_images,
            observe_common_image_build,
            observe_repository_images,
        )

        try:
            credentials = load_operator_credentials()
            credentials.refresh(Request())
            with requests.Session() as session:
                result = observe_repository_images(
                    project=args.project,
                    region=args.region,
                    expected_identity={
                        "name": f"projects/{args.project}/locations/{args.region}/repositories/one-pod",
                        "format": "DOCKER",
                        "createTime": args.repository_created_at,
                    },
                    token=credentials.token,
                    session=session,
                )
                if args.source_image:
                    result["sourceComparison"] = compare_repository_images(
                        inventory=result,
                        source_ref=args.source_image,
                        source_token=credentials.token,
                        destination_token=credentials.token,
                        session=session,
                    )
                if args.build_id:
                    # The source ref is validated by the observer before requests.
                    source_project = args.source_image.split("/")[1]
                    builds = [
                        observe_common_image_build(
                            project=source_project,
                            location=args.build_location,
                            build_id=build_id,
                            source_ref=args.source_image,
                            token=credentials.token,
                            session=session,
                            source_verifier=(
                                lambda build: _verify_build_source(
                                    build,
                                    checkout=str(Path(__file__).resolve().parents[3]),
                                    token=credentials.token,
                                    session=session,
                                )
                            )
                            if args.verify_source
                            else None,
                        )
                        for build_id in args.build_id
                    ]
                    result["buildOutputComparison"] = compare_repository_build_outputs(
                        inventory=result,
                        comparison=result["sourceComparison"],
                        builds=builds,
                    )
            print(json.dumps(result, sort_keys=True))
            return 0
        except Exception as exc:
            print(json.dumps({"classification": "unresolved", "error_type": type(exc).__name__}))
            return 77

    names = _fleet_service_names(args.project, args.region)
    rows = asyncio.run(_registry_rows())
    result = classify_fleet_registry_mismatch(
        fleet_service_names=names,
        registry_rows=rows,
        project=args.project,
        region=args.region,
    )
    a, b = result["direction_a"], result["direction_b"]

    print(f"fleet_services={len(names)} registry_rows={len(rows)}")
    print(f"\nDirection A -- active host claims missing from this fleet observation: {len(a)}")
    for d in a:
        print(f"  {d['service']}  hushh_id={d['hushh_id']}  status={d['status']}")
    print(
        f"\nDirection B -- observed services with no registry claim (review candidates): {len(b)}"
    )
    for d in b:
        print(f"  {d['service']}")
    print(f"\nInactive rows retaining an observed host: {len(result['inactive_claims'])}")
    for d in result["inactive_claims"]:
        print(f"  {d['service']}  status={d['status']}")
    print(f"Unresolved registry claims: {len(result['unresolved'])}")
    if result["unresolved"]:
        print("INCOMPLETE -- unresolved claims suppress orphan conclusions.")
    print(
        "\nREPORT ONLY -- nothing deleted. Reclaim is founder-gated (PERSONAL_AGENT_FLEET_RECLAIM_ENABLED)."
    )
    return 2 if result["unresolved"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
