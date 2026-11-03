#!/usr/bin/env python3
"""Guarded operator entrypoint for the two reviewed Dev billing placements.

The report-only inventory is the review artifact. Mutations require its exact
canonical SHA, an explicit Dev environment, and ``--apply``. Every action is
delegated to the existing hosted lifecycle services and journals.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS

CENTRAL_PROJECT = "hushh-pda-dev"
INFERENCE_BRIDGE_PROJECT = "hushh-gemini-bridge"
PROTECTED_PROJECTS = frozenset(
    {
        CENTRAL_PROJECT,
        INFERENCE_BRIDGE_PROJECT,
        "hushh-pda-uat",
        "hushh-pda-prod",
        "hushh-pda-production",
    }
)
REGION = "us-central1"
OLD_BILLING_ACCOUNT = "billingAccounts/014D7F-FD970D-D2459E"
TARGET_BILLING_ACCOUNT = "billingAccounts/013848-8258FA-2D068F"
EXPECTED_OPERATOR = "user:kushaltrivedi97@gmail.com"
REVIEWED_FOLDER_ID = "1085913534660"
MANIFEST_SCHEMA = "hosted-provider-account-review/v1"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
SOURCE_REVISION_PATTERN = re.compile(r"^[a-f0-9]{40}$")


class OperatorRefused(RuntimeError):
    """A manifest, identity or lifecycle precondition is not established."""


@dataclass(frozen=True)
class InventorySnapshot:
    manifest: dict[str, Any]
    sha256: str
    placements: dict[str, dict[str, Any]]
    unresolved: tuple[str, ...] = ()
    records: dict[str, dict[str, Any]] | None = None

    def report(self) -> dict[str, Any]:
        return {
            "schema": MANIFEST_SCHEMA,
            "manifest": self.manifest,
            "manifestSha256": self.sha256,
            "unresolved": list(self.unresolved),
            "reportOnly": True,
        }


class OperatorRuntime(Protocol):
    async def inventory(self) -> InventorySnapshot: ...

    async def perform(
        self,
        action: str,
        placement: dict[str, Any],
        *,
        reviewed_sha256: str,
        inventory_snapshot: InventorySnapshot,
    ) -> dict[str, Any]: ...


def canonical_manifest_sha256(manifest: dict[str, Any]) -> str:
    """Hash only the canonical, redacted inventory that the operator reviewed."""
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def validate_manifest(manifest: Any) -> str:
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise OperatorRefused("reviewed manifest schema is invalid")
    digest = manifest.get("manifestSha256")
    if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
        raise OperatorRefused("reviewed manifest SHA-256 is invalid")
    return digest


def require_mutation_confirmation(
    *, environment: str | None, apply: bool, supplied_sha256: str | None
) -> None:
    if environment != "dev":
        raise OperatorRefused("mutations require --environment dev")
    if apply is not True:
        raise OperatorRefused("mutations require --apply")
    if not isinstance(supplied_sha256, str) or not SHA256_PATTERN.fullmatch(supplied_sha256):
        raise OperatorRefused("mutations require the reviewed --manifest-sha256")


def require_reviewed_placement(snapshot: InventorySnapshot, *, hushh_id: str) -> dict[str, Any]:
    if snapshot.unresolved:
        raise OperatorRefused("inventory contains unresolved evidence")
    placement = snapshot.placements.get(hushh_id)
    expected = PLACEMENTS.get(hushh_id)
    if not isinstance(placement, dict) or not isinstance(expected, dict):
        raise OperatorRefused("owner is outside the reviewed two-placement manifest")
    project = placement.get("projectId")
    if project in PROTECTED_PROJECTS:
        raise OperatorRefused("protected project cannot be mutated")
    if project != expected["projectId"]:
        raise OperatorRefused("project differs from the reviewed placement")
    if placement.get("identityState") != "verified":
        raise OperatorRefused("native and registry identity is unresolved")
    if placement.get("lifecycleState") not in {
        "provisioned",
        "provisioning",
        "provisioning_failed",
        "suspended",
    }:
        raise OperatorRefused("retained lifecycle phase is not supported")
    return placement


async def execute_action(
    runtime: OperatorRuntime,
    *,
    action: str,
    hushh_id: str | None,
    environment: str | None,
    apply: bool,
    manifest_sha256: str | None,
) -> dict[str, Any]:
    """Inventory, gate a proposed mutation, re-inventory, then delegate once."""
    initial = await runtime.inventory()
    if action == "inventory":
        return initial.report()
    if action not in {"resume", "associate-account", "remove"}:
        raise OperatorRefused("unsupported action")
    if not hushh_id:
        raise OperatorRefused("mutating actions require --hushh-id")
    placement = require_reviewed_placement(initial, hushh_id=hushh_id)
    planned = {
        "action": action,
        "hushhId": hushh_id,
        "projectId": placement["projectId"],
        "operation": (
            "continue_existing_erasure_only"
            if action == "remove"
            else "continue_retained_operation"
        ),
        "reportOnly": True,
        "manifestSha256": initial.sha256,
    }
    if not apply:
        return planned
    require_mutation_confirmation(
        environment=environment,
        apply=apply,
        supplied_sha256=manifest_sha256,
    )
    if manifest_sha256 != initial.sha256:
        raise OperatorRefused("reviewed manifest SHA is stale")

    current = await runtime.inventory()
    if current.unresolved:
        raise OperatorRefused("fresh inventory contains unresolved evidence")
    if current.sha256 != manifest_sha256:
        raise OperatorRefused("native or registry identity changed after review")
    current_placement = require_reviewed_placement(current, hushh_id=hushh_id)
    result = await runtime.perform(
        action,
        current_placement,
        reviewed_sha256=current.sha256,
        inventory_snapshot=current,
    )
    return {
        "action": action,
        "hushhId": hushh_id,
        "projectId": current_placement["projectId"],
        "manifestSha256": current.sha256,
        "result": result,
        "reportOnly": False,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inventory", "resume", "associate-account", "remove"))
    parser.add_argument("--hushh-id", choices=tuple(sorted(PLACEMENTS)))
    parser.add_argument("--environment")
    parser.add_argument("--apply", action="store_true", help="authorize one reviewed Dev action")
    parser.add_argument("--manifest-sha256")
    return parser


def main(argv: list[str] | None = None, *, runtime: OperatorRuntime | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.action != "inventory" and args.apply:
        try:
            require_mutation_confirmation(
                environment=args.environment,
                apply=args.apply,
                supplied_sha256=args.manifest_sha256,
            )
        except OperatorRefused as exc:
            print(json.dumps({"classification": "refused", "reason": str(exc)}))
            return 2
    try:
        selected_runtime = runtime or _build_runtime()
        result = asyncio.run(
            execute_action(
                selected_runtime,
                action=args.action,
                hushh_id=args.hushh_id,
                environment=args.environment,
                apply=args.apply,
                manifest_sha256=args.manifest_sha256,
            )
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except OperatorRefused as exc:
        print(json.dumps({"classification": "refused", "reason": str(exc)}))
        return 2
    except Exception as exc:  # noqa: BLE001 - inventory failures are not absence
        print(
            json.dumps(
                {"classification": "unresolved", "errorType": type(exc).__name__},
                sort_keys=True,
            )
        )
        return 77


def _build_runtime() -> OperatorRuntime:
    """Build a Dev-quota reader and a separate, verified-operator credential handle."""
    import google.auth
    import requests

    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    read_credentials, _ = google.auth.default(scopes=scopes, quota_project_id=CENTRAL_PROJECT)
    operator_credentials = NamedGcloudOperatorCredentials()
    return HostedProviderAccountRuntime(
        credentials=read_credentials,
        operator_credentials=operator_credentials,
        session=requests.Session(),
    )


class NamedGcloudOperatorCredentials:
    """Fetch the explicitly named operator token into memory only.

    The subprocess receives no token argument. Stdout is captured, never logged,
    and C2 verifies the resulting bearer token against Google's userinfo endpoint
    before persisting any intent or issuing a provider billing request.
    """

    def __init__(self) -> None:
        import os
        import shutil

        self._account = EXPECTED_OPERATOR.removeprefix("user:")
        configured = os.getenv("HUSHH_GCLOUD_EXECUTABLE")
        found = configured or shutil.which("gcloud")
        self._binary = os.path.realpath(found) if found and os.path.isabs(found) else None
        self.token: str | None = None
        self.valid = False

    def refresh(self, request: Any = None) -> None:
        import os
        import re
        import subprocess

        del request
        if (
            self._binary is None
            or not os.path.isabs(self._binary)
            or not os.path.isfile(self._binary)
            or not os.access(self._binary, os.X_OK)
        ):
            raise OperatorRefused("named gcloud account credential is unavailable")
        try:
            completed = subprocess.run(  # noqa: S603 -- fixed absolute gcloud command, no shell
                [
                    self._binary,
                    "auth",
                    "print-access-token",
                    f"--account={self._account}",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
                shell=False,
            )
        except Exception:
            self.token = None
            self.valid = False
            raise OperatorRefused(
                "named gcloud account could not provide an operator token"
            ) from None
        token = completed.stdout.strip()
        if completed.returncode != 0 or not re.fullmatch(r"[\x21-\x7e]{20,8192}", token):
            self.token = None
            self.valid = False
            raise OperatorRefused("named gcloud account could not provide an operator token")
        self.token = token
        self.valid = True


class HostedProviderAccountRuntime:
    """Read the reviewed placement set and delegate only to existing lifecycle ports."""

    def __init__(
        self,
        *,
        credentials: Any,
        operator_credentials: Any | None = None,
        session: Any,
        registry: Any | None = None,
        project_reader_factory: Callable[..., Any] | None = None,
        run_client_factory: Callable[..., Any] | None = None,
        transition_factory: Callable[..., Any] | None = None,
        operator_verifier: Callable[..., Any] | None = None,
        project_discovery: Callable[[], list[dict[str, Any]]] | None = None,
    ) -> None:
        self.credentials = credentials
        self.operator_credentials = operator_credentials
        self.session = session
        if registry is None:
            from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

            registry = PersonalAgentRegistryRepo()
        self.registry = registry
        self.project_reader_factory = project_reader_factory or self._project_reader
        self.run_client_factory = run_client_factory or self._run_client
        self.transition_factory = transition_factory or self._transition
        self.operator_verifier = operator_verifier or self._verify_operator
        self.project_discovery = project_discovery or self._discover_projects

    def _project_reader(self, *, project: str, number: str) -> Any:
        from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory

        token = self._access_token()
        reader = NativeProjectInventory(
            project=project, number=number, token=token, session=self.session
        )
        reader._headers["x-goog-user-project"] = CENTRAL_PROJECT
        return reader

    def _run_client(self, *, project: str, region: str) -> Any:
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        class DevQuotaRunClient(GcpRunClient):
            def _headers(inner_self) -> dict[str, str]:
                headers = super(DevQuotaRunClient, inner_self)._headers()
                headers["x-goog-user-project"] = CENTRAL_PROJECT
                return headers

        return DevQuotaRunClient(project=project, region=region, credentials=self.credentials)

    def _transition(self) -> Any:
        from hushh_mcp.services.hosted_provider_account_transition import (
            HostedProviderAccountTransition,
        )

        return HostedProviderAccountTransition(
            self.registry,
            credentials=self.operator_credentials,
            session=self.session,
        )

    def _verify_operator(self, *, expected: str) -> Any:
        from hushh_mcp.services.hosted_operator_identity import verify_operator

        if self.operator_credentials is None:
            raise OperatorRefused("named billing operator credential is unavailable")
        return verify_operator(self.operator_credentials, self.session, expected=expected)

    async def _require_named_operator(self, expected: str) -> Any:
        try:
            operator = await asyncio.to_thread(self.operator_verifier, expected=expected)
        except Exception:
            raise OperatorRefused(
                f"operator credentials must verify as {expected} through Google userinfo"
            ) from None
        if (
            getattr(operator, "principal", None) != expected
            or getattr(operator, "email", None) != expected.removeprefix("user:")
            or getattr(operator, "email_verified", None) is not True
        ):
            raise OperatorRefused(f"operator credentials did not verify as {expected}")
        return operator

    def _access_token(self) -> str:
        from google.auth.transport.requests import Request

        if not getattr(self.credentials, "valid", False):
            self.credentials.refresh(Request(session=self.session))
        token = getattr(self.credentials, "token", None)
        if not isinstance(token, str) or not token:
            raise OperatorRefused("Dev inventory credential is unavailable")
        return token

    def _discover_projects(self) -> list[dict[str, Any]]:
        """List the reviewed owner folder; a partial page set is an error."""
        projects: list[dict[str, Any]] = []
        seen: set[str] = set()
        page_token = ""
        headers = {
            "Authorization": "Bearer " + self._access_token(),
            "x-goog-user-project": CENTRAL_PROJECT,
        }
        for _ in range(100):
            params = {
                "filter": f"parent.type:folder parent.id:{REVIEWED_FOLDER_ID}",
                "pageSize": 100,
            }
            if page_token:
                params["pageToken"] = page_token
            response = self.session.get(
                "https://cloudresourcemanager.googleapis.com/v1/projects",
                params=params,
                headers=headers,
                timeout=20,
                allow_redirects=False,
            )
            if response.status_code != 200:
                raise OperatorRefused("reviewed project folder inventory is unreadable")
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("projects", []), list):
                raise OperatorRefused("reviewed project folder inventory is malformed")
            page = body.get("projects", [])
            if any(not isinstance(item, dict) for item in page):
                raise OperatorRefused("reviewed project folder inventory is malformed")
            projects.extend(page)
            next_token = body.get("nextPageToken", "")
            if not isinstance(next_token, str) or next_token in seen:
                raise OperatorRefused("reviewed project folder pagination is invalid")
            if not next_token:
                return projects
            seen.add(next_token)
            page_token = next_token
        raise OperatorRefused("reviewed project folder pagination limit exceeded")

    async def inventory(self) -> InventorySnapshot:
        from hushh_mcp.services.account_generation_service import AccountGenerationService
        from hushh_mcp.services.pod_fleet_claims import expand_retained_claims
        from scripts.ops.pod_reconcile import hosted_provider_transition_service_candidates

        unresolved: list[str] = []
        records: dict[str, dict[str, Any]] = {}
        placements: dict[str, dict[str, Any]] = {}
        project_identities: dict[str, dict[str, Any]] = {}
        services_by_project: dict[str, list[dict[str, Any]]] = {}
        retained_owner_rows: dict[str, dict[str, Any] | None] = {}
        try:
            fleet_rows = await self.registry.fetch_fleet_inventory()
            claims = expand_retained_claims(fleet_rows)
        except Exception as exc:  # noqa: BLE001 - unreadable registry is not absence
            fleet_rows, claims = [], []
            unresolved.append(f"fleet_registry_unreadable:{type(exc).__name__}")
        invalid_retained_count = sum(
            isinstance(claim, dict) and claim.get("claim_source") == "invalid_retained"
            for claim in claims
        )
        if invalid_retained_count:
            unresolved.append(f"fleet_registry_invalid_retained:{invalid_retained_count}")

        for hushh_id, expected in sorted(PLACEMENTS.items()):
            entry: dict[str, Any] = {
                "hushhId": hushh_id,
                "projectId": expected["projectId"],
                "projectNumber": expected["projectNumber"],
                "placementEpoch": expected["placementEpoch"],
                "attemptId": expected["attemptId"],
                "operationId": expected["operationId"],
                "ownerHash": None,
                "ownerGeneration": None,
                "registryState": "unavailable",
                "identityState": "unresolved",
                "nativeProjectState": "unreadable",
                "nativeServiceState": "unreadable",
                "lifecycleState": "unresolved",
                "serviceCandidates": [],
                "tombstoneState": "unreadable",
                "removalState": "unreadable",
            }
            raw_row: dict[str, Any] | None = None
            try:
                raw_row = await self.registry.get_by_hushh_id(hushh_id)
                if raw_row is not None and not isinstance(raw_row, dict):
                    raise TypeError("registry row malformed")
            except Exception as exc:  # noqa: BLE001 - unreadable registry is not absence
                unresolved.append(f"{hushh_id}:registry_unreadable:{type(exc).__name__}")

            owner = str((raw_row or {}).get("user_id") or "")
            authority_row = _authority_row(raw_row)
            attempt = _attempt(authority_row)
            owner_hash = _owner_hash(owner) if owner else None
            entry["ownerHash"] = owner_hash
            if raw_row is None:
                entry["registryState"] = "absent"
            else:
                entry["registryState"] = str(raw_row.get("status") or "unknown")
                entry["lifecycleState"] = str(raw_row.get("status") or "unknown")
                entry["attemptPhase"] = str(attempt.get("phase") or "unknown")
                entry["erasurePhase"] = _lifecycle_phase(raw_row, attempt)

            generation: int | None = None
            resolved_identity: str | None = None
            identity_error: str | None = None
            if owner:
                try:
                    resolved_identity = await asyncio.to_thread(
                        AccountGenerationService.firebase_identity_for_owner, owner
                    )
                    if not isinstance(resolved_identity, str) or not resolved_identity:
                        raise ValueError("owner identity mapping missing")
                    generation = await asyncio.to_thread(self._owner_generation, owner)
                except Exception as exc:  # noqa: BLE001 - owner map is a required join
                    identity_error = type(exc).__name__
                    unresolved.append(f"{hushh_id}:owner_generation_unresolved:{identity_error}")
            entry["ownerGeneration"] = generation

            auxiliary: dict[str, Any] = {}
            try:
                auxiliary = await self._retained_records(
                    owner_id=owner or None,
                    owner_hash=owner_hash,
                    identity_hash=_owner_hash(resolved_identity) if resolved_identity else None,
                    hushh_id=hushh_id,
                    attempt_id=expected["attemptId"],
                )
                auxiliary["currentErasureTombstonePair"] = _current_erasure_tombstone_pair(
                    raw_row, auxiliary, expected
                )
                entry["tombstoneState"] = _tombstone_summary(auxiliary)
                entry["removalState"] = _removal_summary(auxiliary)
            except Exception as exc:  # noqa: BLE001 - no permission failure becomes empty
                unresolved.append(f"{hushh_id}:retained_archive_unreadable:{type(exc).__name__}")

            project_identity: dict[str, Any] | None = None
            project_reader = None
            try:
                project_reader = self.project_reader_factory(
                    project=expected["projectId"], number=expected["projectNumber"]
                )
                project_identity = await asyncio.to_thread(
                    _read_native_project_identity, project_reader, expected
                )
                project_identities[expected["projectId"]] = project_identity
                lifecycle = project_identity.get("lifecycleState")
                if lifecycle == "DELETE_REQUESTED":
                    entry["nativeProjectState"] = "pending_delete"
                elif lifecycle != "ACTIVE":
                    entry["nativeProjectState"] = "non_active"
                    unresolved.append(f"{hushh_id}:project_not_active")
                else:
                    entry["nativeProjectState"] = "active"
            except Exception as exc:  # noqa: BLE001 - unreadable is never absence
                status_code = getattr(exc, "http_status", None)
                if status_code == 404:
                    entry["nativeProjectState"] = "absent"
                else:
                    entry["nativeProjectState"] = "unreadable"
                    unresolved.append(f"{hushh_id}:native_project_unreadable:{type(exc).__name__}")

            candidates: list[dict[str, Any]] = []
            services: list[dict[str, Any]] = []
            if project_identity and entry["nativeProjectState"] in {"active", "pending_delete"}:
                try:
                    run_client = self.run_client_factory(
                        project=expected["projectId"], region=REGION
                    )
                    services = await asyncio.to_thread(run_client.list_services)
                    services_by_project[expected["projectId"]] = services
                    service_name = _retained_service_name(authority_row, expected)
                    candidates = hosted_provider_transition_service_candidates(
                        services,
                        project_id=expected["projectId"],
                        project_number=expected["projectNumber"],
                        service_name=service_name,
                        attempt_id=expected["attemptId"],
                    )
                    matching = [
                        candidate
                        for candidate in candidates
                        if _service_matches(
                            candidate.get("service"),
                            row=authority_row,
                            expected=expected,
                        )
                    ]
                    entry["nativeServiceState"] = (
                        "verified"
                        if len(matching) == 1 and len(candidates) == 1
                        else "absent"
                        if not candidates
                        else "ambiguous"
                    )
                    entry["serviceCandidates"] = [
                        _service_summary(candidate) for candidate in candidates
                    ]
                    if candidates and (len(matching) != 1 or len(candidates) != 1):
                        unresolved.append(f"{hushh_id}:native_service_identity_mismatch")
                    if not candidates and str((raw_row or {}).get("status") or "") in {
                        "provisioned",
                        "connecting",
                    }:
                        unresolved.append(f"{hushh_id}:retained_service_absent")
                except Exception as exc:  # noqa: BLE001 - list failures are not absence
                    entry["nativeServiceState"] = "unreadable"
                    unresolved.append(f"{hushh_id}:native_service_unreadable:{type(exc).__name__}")

            identity_ok, identity_reason = _retained_identity_matches(
                raw_row=raw_row,
                authority_row=authority_row,
                expected=expected,
                project_identity=project_identity,
                service_candidates=candidates,
                claims=claims,
                auxiliary=auxiliary,
                owner_identity_error=identity_error,
            )
            entry["identityState"] = "verified" if identity_ok else "unresolved"
            if not identity_ok:
                unresolved.append(f"{hushh_id}:{identity_reason or 'retained_identity_unresolved'}")

            transition = (
                attempt.get("providerAccountTransition") if isinstance(attempt, dict) else None
            )
            entry["transitionPhase"] = (
                transition.get("phase") if isinstance(transition, dict) else "none"
            )
            entry["transitionGeneration"] = (
                transition.get("generation") if isinstance(transition, dict) else 0
            )
            entry["projectParent"] = _json_value((project_identity or {}).get("parent"))
            entry["projectLabels"] = _json_value((project_identity or {}).get("labels"))
            entry["creationIdentitySha256"] = _digest(_creation_identity(authority_row))
            entry["registryEvidenceSha256"] = _digest(_registry_evidence(raw_row))
            entry["removalEvidenceSha256"] = _digest(auxiliary.get("removals", []))
            entry["tombstoneEvidenceSha256"] = _digest(
                {
                    "personal": auxiliary.get("personalTombstones", []),
                    "account": auxiliary.get("accountTombstones", []),
                }
            )
            placements[hushh_id] = entry
            records[hushh_id] = {
                "registryRow": raw_row,
                "authorityRow": authority_row,
                "ownerId": owner,
                "resolvedIdentityHash": _owner_hash(resolved_identity)
                if resolved_identity
                else None,
                "ownerGeneration": generation,
                "nativeProject": project_identity,
                "services": services,
                "candidates": candidates,
                "auxiliary": auxiliary,
                "claims": [
                    claim
                    for claim in claims
                    if isinstance(claim, dict) and claim.get("hushh_id") == hushh_id
                ],
            }

        discovered_projects: list[dict[str, Any]] = []
        discovered_candidates: list[dict[str, Any]] = []
        try:
            listed_projects = await asyncio.to_thread(self.project_discovery)
            if not isinstance(listed_projects, list) or any(
                not isinstance(project, dict) for project in listed_projects
            ):
                raise OperatorRefused("reviewed project folder inventory is malformed")
            normalized = []
            for project in listed_projects:
                project_id = project.get("projectId")
                number = project.get("projectNumber")
                parent = project.get("parent")
                labels = project.get("labels")
                labels = labels if isinstance(labels, dict) else {}
                if (
                    not isinstance(project_id, str)
                    or not project_id
                    or not isinstance(number, (str, int))
                    or not isinstance(parent, dict)
                    or parent != {"type": "folder", "id": REVIEWED_FOLDER_ID}
                ):
                    raise OperatorRefused("reviewed project folder member is malformed")
                normalized.append(project)
                label_map = {str(key): str(value) for key, value in labels.items()}
                project_claims = [claim for claim in claims if _claim_project(claim) == project_id]
                prefix_candidate = project_id.startswith("hussh-hp-")
                explicit_hosted_marker = (
                    label_map.get("tenancy") == "hussh-hosted"
                    or label_map.get("hussh-tenancy") == "hussh-hosted"
                    or "hussh-provision-attempt" in label_map
                )
                owner_marker = label_map.get("tenancy") == "user-owned" or any(
                    _claim_is_owner_owned(claim) for claim in project_claims
                )
                claim_hosted = any(_claim_is_hosted(claim) for claim in project_claims)
                hosted_marker = explicit_hosted_marker or claim_hosted
                is_candidate = prefix_candidate or hosted_marker or owner_marker
                if explicit_hosted_marker and owner_marker:
                    unresolved.append(f"project:{project_id}:owner_hosted_evidence_conflict")
                current_identity = project_identities.get(project_id)
                native_state = "unreadable"
                if (
                    current_identity is None
                    and is_candidate
                    and not (owner_marker and not hosted_marker)
                ):
                    try:
                        reader = self.project_reader_factory(project=project_id, number=str(number))
                        current_identity = await asyncio.to_thread(
                            _read_native_project_identity,
                            reader,
                            {"projectId": project_id, "projectNumber": str(number)},
                        )
                        project_identities[project_id] = current_identity
                    except Exception as exc:  # noqa: BLE001 - unreadable is not absence
                        if getattr(exc, "http_status", None) == 404:
                            native_state = "absent"
                        else:
                            unresolved.append(
                                f"project:{project_id}:native_project_unreadable:{type(exc).__name__}"
                            )
                if current_identity is not None:
                    current_labels = current_identity.get("labels") or {}
                    native_state = (
                        "pending_delete"
                        if current_identity.get("lifecycleState") == "DELETE_REQUESTED"
                        else "active"
                        if current_identity.get("lifecycleState") == "ACTIVE"
                        else "non_active"
                    )
                    if (
                        current_identity.get("parent") != parent
                        or str(current_identity.get("projectNumber")) != str(number)
                        or current_labels != label_map
                        or current_identity.get("lifecycleState") != project.get("lifecycleState")
                    ):
                        unresolved.append(f"project:{project_id}:project_list_readback_changed")
                project_summary = {
                    "projectId": project_id,
                    "projectNumber": str(number),
                    "parent": _json_value(parent),
                    "labels": {
                        key: value
                        for key, value in sorted(label_map.items())
                        if key.startswith("hussh-") or key in {"app", "environment"}
                    },
                    "lifecycleState": (current_identity or project).get("lifecycleState"),
                    "nativeProjectState": native_state,
                    "reviewedPlacement": project_id
                    in {p["projectId"] for p in PLACEMENTS.values()},
                    "candidateDiscoveryOnly": is_candidate,
                }
                discovered_projects.append(project_summary)
                if not is_candidate:
                    continue
                if owner_marker and not hosted_marker:
                    known_owner_claim = label_map.get("tenancy") == "user-owned" or any(
                        _claim_is_owner_owned(claim) for claim in project_claims
                    )
                    if not known_owner_claim and native_state == "active":
                        unresolved.append(f"project:{project_id}:owner_candidate_claim_unresolved")
                    discovered_candidates.append(
                        {
                            **project_summary,
                            "classification": (
                                "owner_owned_preserved"
                                if known_owner_claim
                                else "unclassified_owner_candidate"
                            ),
                            "claims": [_claim_summary(claim) for claim in project_claims],
                            "serviceInventoryState": "not_read_for_owner_owned_project",
                            "serviceCandidates": [],
                            "candidateCount": 0,
                            "authorizedForMutation": False,
                        }
                    )
                    continue
                candidate_services = services_by_project.get(project_id)
                service_read_state = "unreadable"
                candidates = []
                if candidate_services is not None:
                    service_read_state = "readable"
                elif native_state in {"active", "pending_delete"}:
                    try:
                        client = self.run_client_factory(project=project_id, region=REGION)
                        candidate_services = await asyncio.to_thread(client.list_services)
                        service_read_state = "readable"
                    except Exception as exc:  # noqa: BLE001 - denied is unresolved
                        unresolved.append(
                            f"project:{project_id}:service_inventory_unreadable:{type(exc).__name__}"
                        )
                else:
                    candidate_services = []
                    service_read_state = "not_active"
                if service_read_state == "readable":
                    try:
                        candidate_map: dict[tuple[str, str], dict[str, Any]] = {}
                        selectors = [
                            (
                                "unmatched-reviewed-project-candidate",
                                "unmatched-reviewed-project-attempt",
                            )
                        ]
                        selectors.extend(
                            (service_name, attempt_id)
                            for claim in project_claims
                            if (service_name := _claim_service(claim))
                            and (attempt_id := _claim_attempt_id(claim))
                        )
                        for service_name, attempt_id in selectors:
                            for candidate in hosted_provider_transition_service_candidates(
                                candidate_services,
                                project_id=project_id,
                                project_number=str(number),
                                service_name=service_name,
                                attempt_id=attempt_id,
                            ):
                                service = candidate.get("service") or {}
                                metadata = service.get("metadata") or {}
                                key = (
                                    str(metadata.get("name") or ""),
                                    str(metadata.get("uid") or ""),
                                )
                                if key in candidate_map:
                                    existing = candidate_map[key]
                                    existing["candidateSources"] = sorted(
                                        set(existing.get("candidateSources", []))
                                        | set(candidate.get("candidateSources", []))
                                    )
                                else:
                                    candidate_map[key] = candidate
                        candidates = list(candidate_map.values())
                    except Exception as exc:  # noqa: BLE001 - malformed service list
                        unresolved.append(
                            f"project:{project_id}:service_candidates_unreadable:{type(exc).__name__}"
                        )
                        service_read_state = "unreadable"
                hosted_claims = [claim for claim in project_claims if _claim_is_hosted(claim)]
                reviewed_project = project_id in {
                    placement["projectId"] for placement in PLACEMENTS.values()
                }
                hosted_claim_services_verified = False
                if hosted_claims and not reviewed_project:
                    hosted_claim_services_verified = service_read_state == "readable"
                    matched_service_ids: set[int] = set()
                    for claim in hosted_claims:
                        hushh_id = claim.get("hushh_id") if isinstance(claim, dict) else None
                        if not isinstance(hushh_id, str) or not hushh_id:
                            hosted_claim_services_verified = False
                            unresolved.append(
                                f"project:{project_id}:retained_hosted_claim_owner_missing"
                            )
                            continue
                        if hushh_id not in retained_owner_rows:
                            try:
                                owner_row = await self.registry.get_by_hushh_id(hushh_id)
                                retained_owner_rows[hushh_id] = (
                                    owner_row
                                    if isinstance(owner_row, dict)
                                    and owner_row.get("hushh_id") == hushh_id
                                    and isinstance(owner_row.get("user_id"), str)
                                    and owner_row.get("user_id")
                                    else None
                                )
                            except Exception:  # noqa: BLE001 - owner resolution is fail-closed
                                retained_owner_rows[hushh_id] = None
                        owner_row = retained_owner_rows[hushh_id]
                        if owner_row is None:
                            hosted_claim_services_verified = False
                            unresolved.append(
                                f"project:{project_id}:retained_hosted_claim_owner_unresolved"
                            )
                            continue
                        expected_service = _retained_hosted_service_expectation(
                            claim,
                            owner_id=owner_row["user_id"],
                            project_id=project_id,
                            project_number=str(number),
                        )
                        if expected_service is None:
                            hosted_claim_services_verified = False
                            unresolved.append(
                                f"project:{project_id}:retained_hosted_claim_identity_incomplete"
                            )
                            continue
                        claim_candidates = hosted_provider_transition_service_candidates(
                            candidate_services or [],
                            project_id=project_id,
                            project_number=str(number),
                            service_name=expected_service["service"],
                            attempt_id=expected_service["attemptId"],
                        )
                        matching_claim_candidates = [
                            candidate
                            for candidate in claim_candidates
                            if _retained_hosted_service_matches(
                                candidate.get("service"), expected_service
                            )
                        ]
                        if len(matching_claim_candidates) != 1:
                            hosted_claim_services_verified = False
                            unresolved.append(
                                f"project:{project_id}:retained_hosted_service_match_count_"
                                f"{expected_service['attemptId']}:{len(matching_claim_candidates)}"
                            )
                            continue
                        matched_service_id = id(matching_claim_candidates[0].get("service"))
                        if matched_service_id in matched_service_ids:
                            hosted_claim_services_verified = False
                            unresolved.append(
                                f"project:{project_id}:retained_hosted_service_reused"
                            )
                            continue
                        matched_service_ids.add(matched_service_id)
                    candidate_service_ids = {
                        id(candidate.get("service")) for candidate in candidates
                    }
                    if candidate_service_ids - matched_service_ids:
                        hosted_claim_services_verified = False
                        unresolved.append(
                            f"project:{project_id}:unmatched_hosted_service_candidate"
                        )
                classification = (
                    "reviewed_two_placement"
                    if reviewed_project
                    else "registry_retained_hosted"
                    if hosted_claims and hosted_claim_services_verified
                    else "unresolved_registry_retained_hosted"
                    if hosted_claims
                    else "unclassified_active_hosted_candidate"
                )
                if native_state == "active" and not hosted_claims and not reviewed_project:
                    unresolved.append(f"project:{project_id}:unclassified_active_hosted_candidate")
                if (
                    native_state == "active"
                    and (hosted_marker or prefix_candidate)
                    and not candidates
                ):
                    unresolved.append(f"project:{project_id}:hosted_candidate_service_missing")
                discovered_candidates.append(
                    {
                        **project_summary,
                        "classification": classification,
                        "claims": [_claim_summary(claim) for claim in project_claims],
                        "serviceInventoryState": service_read_state,
                        "serviceCandidates": [_service_summary(item) for item in candidates],
                        "candidateCount": len(candidates),
                        "authorizedForMutation": False,
                    }
                )
            expected_ids = {placement["projectId"] for placement in PLACEMENTS.values()}
            discovered_ids = {project["projectId"] for project in normalized}
            if not expected_ids.issubset(discovered_ids):
                unresolved.append("reviewed_project_folder_missing_pilot_project")
            discovered_projects.sort(key=lambda item: item["projectId"])
            discovered_candidates.sort(key=lambda item: item["projectId"])
        except Exception as exc:  # noqa: BLE001 - incomplete listing is not absence
            unresolved.append(f"reviewed_project_folder_unreadable:{type(exc).__name__}")
            discovered_projects = []
            discovered_candidates = []

        unresolved = list(dict.fromkeys(unresolved))
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "environment": "dev",
            "region": REGION,
            "oldBillingAccount": OLD_BILLING_ACCOUNT,
            "targetBillingAccount": TARGET_BILLING_ACCOUNT,
            "placements": [placements[key] for key in sorted(placements)],
            "reviewedFolderId": REVIEWED_FOLDER_ID,
            "discoveredProjects": discovered_projects,
            "discoveredHostedCandidates": discovered_candidates,
            "unresolved": unresolved,
        }
        return InventorySnapshot(
            manifest=manifest,
            sha256=canonical_manifest_sha256(manifest),
            placements=placements,
            unresolved=tuple(unresolved),
            records=records,
        )

    def _owner_generation(self, owner_id: str) -> int:
        result = self.registry._db().execute_raw(
            "SELECT to_regclass('public.account_generations') IS NOT NULL AS installed", {}
        )
        if not result.data or result.data[0].get("installed") is not True:
            if owner_id.startswith("acct_"):
                raise OperatorRefused("account-generation binding is unavailable")
            return 0
        owner_hash = _owner_hash(owner_id)
        result = self.registry._db().execute_raw(
            "SELECT generation,owner_id,retired_at FROM public.account_generations "
            "WHERE owner_hash=:owner_hash",
            {"owner_hash": owner_hash},
        )
        if result.data:
            row = result.data[0]
            if row.get("owner_id") != owner_id or row.get("retired_at") is not None:
                raise OperatorRefused("account-generation binding is retired or foreign")
            generation = row.get("generation")
            if type(generation) is not int or generation < 0:
                raise OperatorRefused("account-generation binding is malformed")
            return generation
        if owner_id.startswith("acct_"):
            raise OperatorRefused("account-generation binding is missing")
        return 0

    async def _retained_records(
        self,
        *,
        owner_id: str | None,
        owner_hash: str | None,
        identity_hash: str | None,
        hushh_id: str,
        attempt_id: str,
    ) -> dict[str, Any]:
        db = self.registry._db()

        def read() -> dict[str, Any]:
            installed = db.execute_raw(
                "SELECT to_regclass('public.personal_agent_deletion_tombstones') IS NOT NULL AS personal, "
                "to_regclass('public.account_deletion_tombstones') IS NOT NULL AS account, "
                "to_regclass('public.personal_agent_cloud_removals') IS NOT NULL AS removals",
                {},
            )
            if (
                not installed.data
                or installed.data[0].get("personal") is not True
                or installed.data[0].get("account") is not True
                or installed.data[0].get("removals") is not True
            ):
                raise OperatorRefused("retained removal and tombstone schema is unavailable")
            personal = db.execute_raw(
                "SELECT to_jsonb(t) AS record FROM public.personal_agent_deletion_tombstones t "
                "WHERE hushh_id=:hushh_id ORDER BY created_at,id",
                {"hushh_id": hushh_id},
            )
            removals = db.execute_raw(
                "SELECT to_jsonb(c) AS record FROM public.personal_agent_cloud_removals c "
                "WHERE attempt_id=:attempt_id OR (:owner_id IS NOT NULL AND user_id=:owner_id) "
                "ORDER BY created_at,attempt_id",
                {"attempt_id": attempt_id, "owner_id": owner_id},
            )
            account_records = []
            if owner_hash or identity_hash:
                result = db.execute_raw(
                    "SELECT to_jsonb(t) AS record FROM public.account_deletion_tombstones t "
                    "WHERE (:owner_hash IS NOT NULL AND user_id_hash=:owner_hash) "
                    "OR (:identity_hash IS NOT NULL AND firebase_identity_hash=:identity_hash)",
                    {"owner_hash": owner_hash, "identity_hash": identity_hash},
                )
                account_records = [row.get("record") for row in result.data or []]
            return {
                "personalTombstones": [row.get("record") for row in personal.data or []],
                "removals": [row.get("record") for row in removals.data or []],
                "accountTombstones": account_records,
            }

        return await asyncio.to_thread(read)

    async def perform(
        self,
        action: str,
        placement: dict[str, Any],
        *,
        reviewed_sha256: str,
        inventory_snapshot: InventorySnapshot | None = None,
    ) -> dict[str, Any]:
        selected = str(placement.get("hushhId") or "")
        fresh = inventory_snapshot or await self.inventory()
        if fresh.unresolved or fresh.sha256 != reviewed_sha256:
            raise OperatorRefused("identity changed immediately before lifecycle dispatch")
        current = require_reviewed_placement(fresh, hushh_id=selected)
        record = (fresh.records or {}).get(selected)
        row = (record or {}).get("registryRow")
        owner = (record or {}).get("ownerId")
        authority_row = (record or {}).get("authorityRow")
        if not isinstance(row, dict) or not isinstance(owner, str) or not owner:
            raise OperatorRefused("retained registry owner is unavailable")
        if row.get("status") == "suspended" and action != "remove":
            raise OperatorRefused("suspended placements only continue through retained erasure")
        if (
            current.get("tombstoneState", {}).get("state") == "current_erasure"
            and action != "remove"
        ):
            raise OperatorRefused(
                "pending deletion tombstone only permits retained erasure continuation"
            )
        if action in {"associate-account", "resume"} and (
            current.get("nativeProjectState") != "active"
            or current.get("nativeServiceState") != "verified"
        ):
            raise OperatorRefused("provider transition requires the exact active native service")
        if current.get("transitionPhase") in {"intent", "unknown"}:
            if action != "resume":
                raise OperatorRefused("unresolved provider account transition blocks this action")
            transition = self.transition_factory()
            result = await transition.resume(owner_id=owner)
            return _safe_result(result)
        if action == "associate-account":
            if current.get("transitionPhase") != "none":
                raise OperatorRefused("provider account transition already has evidence")
            # C2 performs signed Google userinfo verification against this exact named
            # operator before recording the intent and refuses ADC principals that differ.
            await self._require_named_operator(EXPECTED_OPERATOR)
            transition = self.transition_factory()
            return _safe_result(await transition.start(owner_id=owner))
        if action == "resume":
            if _creation_recovery_ready(authority_row):
                return await self._resume_existing_creation(owner_id=owner, row=row, record=record)
            raise OperatorRefused("no retained transition or reconcilable existing creation")
        if action == "remove":
            return await self._remove_through_retained_erasure(owner_id=owner, row=row)
        raise OperatorRefused("unsupported lifecycle action")

    async def _resume_existing_creation(
        self, *, owner_id: str, row: dict[str, Any], record: dict[str, Any]
    ) -> dict[str, Any]:
        from dataclasses import replace

        from hushh_mcp.services.compute_backend import PodSpec
        from hushh_mcp.services.hosted_gcp_admission import deployment_from_reservation
        from hushh_mcp.services.hosted_provision_recovery import reconcile_existing_creation

        attempt = _attempt(row)
        creation = _creation_identity(row)
        if not isinstance(attempt, dict) or not isinstance(creation, dict):
            raise OperatorRefused("retained creation authority is unavailable")
        admission = attempt.get("hostedAdmission")
        assignment = admission.get("assignment") if isinstance(admission, dict) else None
        if not isinstance(admission, dict) or not isinstance(assignment, dict):
            raise OperatorRefused("retained creation admission is unavailable")
        source_revision = str(os.getenv("HUSHH_DEPLOY_SHA") or "").strip().lower()
        if (
            not SOURCE_REVISION_PATTERN.fullmatch(source_revision)
            or admission.get("sourceRevision") != source_revision
        ):
            raise OperatorRefused("installed control-plane source revision differs from admission")
        owner_hash = _owner_hash(owner_id)
        if (
            assignment.get("ownerHash") != owner_hash
            or assignment.get("project") != PLACEMENTS[row["hushh_id"]]["projectId"]
        ):
            raise OperatorRefused("retained creation placement differs")
        cloud = await self.registry.get(owner_id)
        if not isinstance(cloud, dict) or cloud != row:
            raise OperatorRefused("registry row changed before existing-create recovery")
        latest = record.get("services") or []
        service = next(
            (
                item
                for item in latest
                if _service_matches(item, row=row, expected=PLACEMENTS[row["hushh_id"]])
            ),
            None,
        )
        if service is None:
            raise OperatorRefused("existing exact service is absent; create is not permitted")
        federation = assignment.get("bootstrapContract", {}).get("plan", {}).get("federation", {})
        hub_principal = federation.get("granted_to")
        if not isinstance(hub_principal, str) or not hub_principal:
            raise OperatorRefused("retained hub principal is unavailable")
        release = {
            "sourceRevision": source_revision,
            "image": f"gcr.io/{CENTRAL_PROJECT}/consent-protocol-pod@{admission.get('imageDigest')}",
        }
        spec = PodSpec(
            hushh_id=row["hushh_id"],
            provision_attempt_id=attempt.get("attemptId"),
            expected_service_uid=PLACEMENTS[row["hushh_id"]]["serviceUid"],
            deployment_target="gcp",
            region=assignment.get("region"),
            model_credential_mode="fleet_adc",
        )
        deployment = deployment_from_reservation(
            spec, attempt, release=release, hub_principal=hub_principal
        )
        spec = replace(spec, private_gcp_deployment=deployment)

        loop = asyncio.get_running_loop()

        def publish(receipt: dict[str, Any]) -> None:
            future = asyncio.run_coroutine_threadsafe(
                self.registry.publish_provision(
                    user_id=owner_id,
                    attempt_id=attempt["attemptId"],
                    expected_phase="host_requested",
                    next_phase="host_requested",
                    evidence={"creationAcknowledgement": receipt},
                ),
                loop,
            )
            if future.result(timeout=30) is not True:
                raise OperatorRefused("existing creation acknowledgement CAS refused")

        spec = replace(spec, on_provision_ack=publish)
        if not await self.registry.hosted_execution_current(
            purpose="provision",
            owner_id=owner_id,
            attempt_id=attempt["attemptId"],
            admission=admission,
            project_observation=attempt.get("evidence", {})
            .get("reserved", {})
            .get("projectObservation"),
        ):
            raise OperatorRefused("hosted create recovery admission is no longer current")

        class ExistingBackend:
            backend_id = "gcp"

        await reconcile_existing_creation(ExistingBackend(), spec, service)
        return {"status": "existing_creation_acknowledged", "attemptId": attempt["attemptId"]}

    async def _remove_through_retained_erasure(
        self, *, owner_id: str, row: dict[str, Any]
    ) -> dict[str, Any]:
        from hushh_mcp.services.hosted_model_grant_cleanup import erase_managed_model_grants
        from hushh_mcp.services.hosted_prefix_abort_operator import HostedPrefixAbortOperator
        from hushh_mcp.services.hosted_preparation_cleanup import cleanup_managed_preparation
        from hushh_mcp.services.hosted_project_retirement import retire_managed_project
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )

        erasure = (row.get("backend_metadata") or {}).get("erasure")
        if (
            row.get("status") != "suspended"
            or not isinstance(erasure, dict)
            or erasure.get("ownerId") != owner_id
            or not isinstance(erasure.get("attemptId"), str)
            or not isinstance(erasure.get("registrySnapshot"), dict)
        ):
            raise OperatorRefused("remove requires an existing retained erasure reservation")
        snapshot = erasure["registrySnapshot"]
        attempt = _attempt(snapshot)
        assignment = (
            attempt.get("hostedAdmission", {}).get("assignment")
            if isinstance(attempt, dict)
            else None
        )
        contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
        actor = contract.get("operatorPrincipal") if isinstance(contract, dict) else None
        if actor != EXPECTED_OPERATOR:
            raise OperatorRefused("retained removal operator is not the named pilot principal")
        operator = await self._require_named_operator(actor)
        token = operator.token

        class RetainedManagedErasure:
            async def preparation(inner_self, *, user_id: str, reservation: dict) -> None:
                await cleanup_managed_preparation(
                    self.registry,
                    user_id=user_id,
                    actor=actor,
                    token=token,
                    session=self.session,
                )

            async def prefix_abort(inner_self, *, user_id: str, reservation: dict) -> None:
                await HostedPrefixAbortOperator(
                    self.registry, actor=actor, token=token, session=self.session
                ).prefix_abort(user_id=user_id, reservation=reservation)

            async def model_grants(inner_self, *, user_id: str, reservation: dict) -> None:
                await erase_managed_model_grants(
                    self.registry,
                    user_id=user_id,
                    actor=actor,
                    token=token,
                    session=self.session,
                )

            async def retirement(inner_self, *, user_id: str, reservation: dict) -> None:
                await retire_managed_project(
                    self.registry,
                    user_id=user_id,
                    actor=actor,
                    token=token,
                    session=self.session,
                )

        service = PersonalAgentProvisioningService(
            registry=self.registry, managed_erasure=RetainedManagedErasure()
        )
        result = await service.deprovision(
            user_id=owner_id, expected_erasure_attempt=erasure["attemptId"]
        )
        return _safe_result(result)


def _owner_hash(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _digest(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return str(value)


def _authority_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    erasure = (row.get("backend_metadata") or {}).get("erasure")
    snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    return snapshot if isinstance(snapshot, dict) else row


def _attempt(row: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {}
    metadata = row.get("backend_metadata")
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    return attempt if isinstance(attempt, dict) else {}


def _lifecycle_phase(row: dict[str, Any], attempt: dict[str, Any]) -> str:
    status = str(row.get("status") or "unknown")
    if status == "suspended":
        erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
        return "erasure_" + str(erasure.get("phase") or "reserved")
    if status in {"provisioning", "connecting", "provisioned", "provisioning_failed"}:
        return str(attempt.get("phase") or status)
    return status


def _creation_identity(row: dict[str, Any] | None) -> dict[str, Any]:
    attempt = _attempt(row)
    evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
    reserved = evidence.get("reserved") if isinstance(evidence.get("reserved"), dict) else {}
    checkpoint = reserved.get("hostedPreparation")
    completed = checkpoint.get("completed") if isinstance(checkpoint, dict) else None
    if isinstance(completed, list) and completed and isinstance(completed[0], dict):
        observation = completed[0].get("resourceObservation")
        identity = observation.get("identity") if isinstance(observation, dict) else None
        return identity if isinstance(identity, dict) else {}
    return {}


def _retained_service_name(row: dict[str, Any] | None, expected: dict[str, Any]) -> str:
    if isinstance(row, dict):
        metadata = row.get("backend_metadata") or {}
        attempt = _attempt(row)
        evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
        host_requested = evidence.get("host_requested")
        acknowledgement = (
            host_requested.get("creationAcknowledgement")
            if isinstance(host_requested, dict)
            else None
        )
        if isinstance(acknowledgement, dict) and isinstance(acknowledgement.get("service"), str):
            return acknowledgement["service"]
        if isinstance(metadata.get("service"), str) and metadata["service"]:
            return metadata["service"]
        from hushh_mcp.services.gcp_backend import _service_name

        return _service_name(str(row.get("hushh_id") or expected["hushhId"]))
    from hushh_mcp.services.gcp_backend import _service_name

    return _service_name(expected["hushhId"])


def _service_parts(
    service: Any,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    metadata = service.get("metadata") if isinstance(service, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    labels = metadata.get("labels") if isinstance(metadata.get("labels"), dict) else {}
    service_spec = service.get("spec") if isinstance(service, dict) else None
    service_spec = service_spec if isinstance(service_spec, dict) else {}
    template = service_spec.get("template")
    template = template if isinstance(template, dict) else {}
    template_spec = template.get("spec")
    template_spec = template_spec if isinstance(template_spec, dict) else {}
    containers = template_spec.get("containers")
    container = containers[0] if isinstance(containers, list) and len(containers) == 1 else {}
    return metadata, labels, template_spec, container if isinstance(container, dict) else {}


def _service_matches(service: Any, *, row: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    if not isinstance(service, dict) or not isinstance(row, dict):
        return False
    metadata, labels, template_spec, container = _service_parts(service)
    attempt = _attempt(row)
    identity = _creation_identity(row)
    metadata_row = row.get("backend_metadata") or {}
    expected_name = _retained_service_name(row, expected)
    image = container.get("image")
    runtime = template_spec.get("serviceAccountName")
    return bool(
        metadata.get("name") == expected_name
        and metadata.get("namespace") == expected["projectNumber"]
        and metadata.get("uid") == expected["serviceUid"]
        and labels.get("app") == "hussh-one-pod"
        and labels.get("hussh-tenancy") == "hussh-hosted"
        and labels.get("hussh-provision-attempt") == expected["attemptId"]
        and runtime == expected["runtimePrincipal"]
        and image
        == (
            f"{REGION}-docker.pkg.dev/{expected['projectId']}/one-pod/"
            "consent-protocol-pod@sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
        )
        and attempt.get("attemptId") == expected["attemptId"]
        and identity.get("projectId") == expected["projectId"]
        and identity.get("projectNumber") == expected["projectNumber"]
        and metadata_row.get("project") == expected["projectId"]
        and metadata_row.get("runtime_service_account") == expected["runtimePrincipal"]
        and metadata_row.get("serviceUid", expected["serviceUid"]) == expected["serviceUid"]
    )


def _service_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    service = candidate.get("service")
    metadata, labels, template_spec, container = _service_parts(service)
    return {
        "name": metadata.get("name"),
        "namespace": metadata.get("namespace"),
        "serviceUid": metadata.get("uid"),
        "candidateSources": list(candidate.get("candidateSources") or []),
        "labels": {
            key: labels.get(key)
            for key in (
                "app",
                "hussh-tenancy",
                "hussh-provision-attempt",
                "hussh-env",
                "hussh-purpose",
            )
            if isinstance(labels.get(key), str)
        },
        "runtimePrincipal": template_spec.get("serviceAccountName"),
        "image": container.get("image"),
    }


def _retained_identity_matches(
    *,
    raw_row: dict[str, Any] | None,
    authority_row: dict[str, Any] | None,
    expected: dict[str, Any],
    project_identity: dict[str, Any] | None,
    service_candidates: list[dict[str, Any]],
    claims: list[dict[str, Any]],
    auxiliary: dict[str, Any],
    owner_identity_error: str | None,
) -> tuple[bool, str | None]:
    if not isinstance(raw_row, dict) or not isinstance(authority_row, dict):
        return False, "registry_owner_missing"
    owner = raw_row.get("user_id")
    if not isinstance(owner, str) or not owner or owner_identity_error:
        return False, "owner_generation_unresolved"
    erasure = (raw_row.get("backend_metadata") or {}).get("erasure")
    erasure_snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    valid_erasure = bool(
        raw_row.get("status") == "suspended"
        and isinstance(erasure, dict)
        and erasure.get("ownerId") == owner
        and isinstance(erasure.get("attemptId"), str)
        and isinstance(erasure_snapshot, dict)
        and erasure_snapshot.get("user_id") == owner
        and erasure_snapshot.get("hushh_id") == expected["hushhId"]
        and erasure_snapshot.get("placement_epoch") == expected["placementEpoch"]
        and _attempt(erasure_snapshot).get("attemptId") == expected["attemptId"]
    )
    active_account_tombstones = [
        item
        for item in auxiliary.get("accountTombstones", [])
        if isinstance(item, dict) and item.get("cleanup_status") != "completed"
    ]
    if active_account_tombstones:
        return False, "owner_tombstone_retained"
    personal_tombstones = auxiliary.get("personalTombstones", [])
    current_tombstone_pair = _current_erasure_tombstone_pair(raw_row, auxiliary, expected)
    if personal_tombstones and not current_tombstone_pair:
        return False, "owner_tombstone_not_bound_to_current_erasure"
    current_removals = [
        item
        for item in auxiliary.get("removals", [])
        if isinstance(item, dict)
        and item.get("attempt_id") == expected["attemptId"]
        and item.get("placement_epoch") == expected["placementEpoch"]
    ]
    if any(item.get("completed_at") is not None for item in current_removals):
        return False, "current_placement_removal_archive_retained"
    expected_claims = [
        claim
        for claim in claims
        if claim.get("hushh_id") == expected["hushhId"] and claim.get("claim_source") == "primary"
    ]
    if len(expected_claims) != 1:
        return False, "fleet_registry_claim_missing_or_ambiguous"
    attempt = _attempt(authority_row)
    metadata = authority_row.get("backend_metadata") or {}
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    observation = (
        attempt.get("evidence", {}).get("reserved", {}).get("projectObservation")
        if isinstance(attempt.get("evidence"), dict)
        else None
    )
    identity = _creation_identity(authority_row)
    prep = (
        attempt.get("evidence", {}).get("reserved", {}).get("hostedPreparation")
        if isinstance(attempt.get("evidence"), dict)
        else None
    )
    completed = prep.get("completed") if isinstance(prep, dict) else None
    contract = assignment.get("preparationContract") if isinstance(assignment, dict) else None
    if (
        attempt.get("ownerId") != owner
        or attempt.get("attemptId") != expected["attemptId"]
        or attempt.get("intent", {}).get("user_id") != owner
        or attempt.get("intent", {}).get("hushh_id") != expected["hushhId"]
        or authority_row.get("hushh_id") != expected["hushhId"]
        or authority_row.get("placement_epoch") != expected["placementEpoch"]
        or authority_row.get("deployment_target") != "gcp"
        or authority_row.get("backend") != "gcp"
        or metadata.get("tenancy", "hussh-hosted") != "hussh-hosted"
        or metadata.get("project") != expected["projectId"]
        or metadata.get("region") != REGION
        or metadata.get("runtime_service_account") != expected["runtimePrincipal"]
        or metadata.get("serviceUid", expected["serviceUid"]) != expected["serviceUid"]
        or not isinstance(admission, dict)
        or admission.get("environment") != "dev"
        or admission.get("imageDigest")
        != "sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1"
        or not isinstance(assignment, dict)
        or assignment.get("project") != expected["projectId"]
        or assignment.get("projectNumber") not in {None, expected["projectNumber"]}
        or assignment.get("hushhId") != expected["hushhId"]
        or assignment.get("ownerHash") != _owner_hash(owner)
        or not isinstance(contract, dict)
        or contract.get("billingAccount") != OLD_BILLING_ACCOUNT
        or not isinstance(completed, list)
        or [item.get("step") for item in completed if isinstance(item, dict)]
        != [
            "create_project",
            "link_billing",
            "authorize_project",
            "inference_vertex",
            "inference_quota",
        ]
        or not isinstance(observation, dict)
        or observation.get("projectId") != expected["projectId"]
        or observation.get("projectNumber") != expected["projectNumber"]
        or not isinstance(identity, dict)
        or identity.get("projectId") != expected["projectId"]
        or identity.get("projectNumber") != expected["projectNumber"]
        or identity.get("lifecycleState") != "ACTIVE"
        or not isinstance(identity.get("parent"), dict)
        or not isinstance(identity.get("labels"), dict)
    ):
        return False, "retained_creation_identity_mismatch"
    if project_identity is None:
        return False, "native_project_identity_unavailable"
    if (
        project_identity.get("projectId") != expected["projectId"]
        or str(project_identity.get("projectNumber")) != expected["projectNumber"]
        or project_identity.get("parent") != identity.get("parent")
        or project_identity.get("labels") != identity.get("labels")
        or project_identity.get("lifecycleState") not in {"ACTIVE", "DELETE_REQUESTED"}
    ):
        return False, "native_project_identity_mismatch"
    if project_identity.get("lifecycleState") == "DELETE_REQUESTED":
        if not valid_erasure:
            return False, "project_delete_requested_without_erasure"
    if service_candidates:
        matches = [
            candidate
            for candidate in service_candidates
            if _service_matches(candidate.get("service"), row=authority_row, expected=expected)
        ]
        if len(matches) != 1 or len(service_candidates) != 1:
            return False, "native_service_identity_mismatch"
    else:
        if not (
            valid_erasure
            and project_identity.get("lifecycleState") == "DELETE_REQUESTED"
            and _retirement_pending_proven(raw_row, expected)
        ):
            return False, "native_service_missing_without_retirement_receipt"
    return True, None


def _retirement_pending_proven(row: dict[str, Any], expected: dict[str, Any]) -> bool:
    erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
    retirement = erasure.get("managedProjectRetirement")
    if not isinstance(retirement, dict):
        return False
    deletion = retirement.get("deletion")
    if not isinstance(deletion, dict):
        return False
    project_identity = deletion.get("projectIdentity")
    return bool(
        deletion.get("ownerId") == row.get("user_id")
        and deletion.get("attemptId") == erasure.get("attemptId")
        and deletion.get("project") == expected["projectId"]
        and deletion.get("projectNumber") == expected["projectNumber"]
        and deletion.get("status") == "retirement_pending_provider_purge"
        and isinstance(project_identity, dict)
        and project_identity.get("projectId") == expected["projectId"]
        and str(project_identity.get("projectNumber")) == expected["projectNumber"]
        and project_identity.get("lifecycleState") == "DELETE_REQUESTED"
    )


def _read_native_project_identity(reader: Any, expected: dict[str, Any]) -> dict[str, Any]:
    url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{expected['projectId']}"
    response = reader.response(url, {})
    if response.status_code != 200:
        error = RuntimeError("native project read failed")
        error.http_status = response.status_code
        raise error
    value = reader.body(response)
    if (
        not isinstance(value, dict)
        or value.get("projectId") != expected["projectId"]
        or str(value.get("projectNumber")) != expected["projectNumber"]
    ):
        raise OperatorRefused("native project ID or number differs from reviewed manifest")
    return value


def _registry_evidence(row: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {"state": "absent"}
    authority = _authority_row(row) or {}
    attempt = _attempt(authority)
    admission = attempt.get("hostedAdmission") or {}
    assignment = admission.get("assignment") or {}
    erasure = (row.get("backend_metadata") or {}).get("erasure") or {}
    return {
        "ownerHash": _owner_hash(str(row.get("user_id") or "")),
        "hushhId": row.get("hushh_id"),
        "status": row.get("status"),
        "placementEpoch": row.get("placement_epoch"),
        "backend": row.get("backend"),
        "deploymentTarget": row.get("deployment_target"),
        "project": (authority.get("backend_metadata") or {}).get("project"),
        "region": (authority.get("backend_metadata") or {}).get("region"),
        "service": (authority.get("backend_metadata") or {}).get("service"),
        "serviceUid": (authority.get("backend_metadata") or {}).get("serviceUid"),
        "runtimePrincipal": (authority.get("backend_metadata") or {}).get(
            "runtime_service_account"
        ),
        "attemptId": attempt.get("attemptId"),
        "attemptPhase": attempt.get("phase"),
        "admission": {
            "environment": admission.get("environment"),
            "sourceRevision": admission.get("sourceRevision"),
            "imageDigest": admission.get("imageDigest"),
            "project": assignment.get("project"),
            "projectNumber": assignment.get("projectNumber"),
            "ownerHash": assignment.get("ownerHash"),
        },
        "transition": _transition_summary(attempt.get("providerAccountTransition")),
        "erasure": {
            "ownerHash": _owner_hash(str(erasure.get("ownerId") or ""))
            if erasure.get("ownerId")
            else None,
            "attemptId": erasure.get("attemptId"),
            "phase": erasure.get("phase"),
            "snapshotSha256": _digest(erasure.get("registrySnapshot"))
            if isinstance(erasure.get("registrySnapshot"), dict)
            else None,
        },
    }


def _transition_summary(transition: Any) -> dict[str, Any] | None:
    if not isinstance(transition, dict):
        return None
    return {
        "phase": transition.get("phase"),
        "generation": transition.get("generation"),
        "settlementCount": len(transition.get("settlements", []))
        if isinstance(transition.get("settlements"), list)
        else None,
        "intentSha256": _digest(transition.get("intent"))
        if isinstance(transition.get("intent"), dict)
        else None,
    }


def _tombstone_summary(auxiliary: dict[str, Any]) -> dict[str, Any]:
    personal = auxiliary.get("personalTombstones") or []
    accounts = auxiliary.get("accountTombstones") or []
    account_states = sorted(
        str(item.get("cleanup_status") or "unknown") for item in accounts if isinstance(item, dict)
    )
    if not personal and not accounts:
        return {"state": "none"}
    current_erasure_pair = bool(auxiliary.get("currentErasureTombstonePair") is True)
    return {
        "state": "current_erasure" if current_erasure_pair else "retained",
        "personalCount": len(personal),
        "personalStatuses": sorted(
            str(item.get("status") or "unknown") for item in personal if isinstance(item, dict)
        ),
        "accountStatuses": account_states,
    }


def _current_erasure_tombstone_pair(
    row: dict[str, Any] | None, auxiliary: dict[str, Any], expected: dict[str, Any]
) -> bool:
    if not isinstance(row, dict) or row.get("status") != "suspended":
        return False
    metadata = row.get("backend_metadata") or {}
    erasure = metadata.get("erasure") if isinstance(metadata, dict) else None
    snapshot = erasure.get("registrySnapshot") if isinstance(erasure, dict) else None
    if (
        not isinstance(erasure, dict)
        or erasure.get("ownerId") != row.get("user_id")
        or not isinstance(erasure.get("attemptId"), str)
        or not isinstance(snapshot, dict)
        or snapshot.get("hushh_id") != expected["hushhId"]
        or snapshot.get("placement_epoch") != expected["placementEpoch"]
        or _attempt(snapshot).get("attemptId") != expected["attemptId"]
    ):
        return False
    tombstones = auxiliary.get("personalTombstones") or []
    return bool(
        tombstones
        and all(
            isinstance(item, dict)
            and item.get("hushh_id") == expected["hushhId"]
            and item.get("status") == "deprovision_requested"
            and item.get("external_agent_id") == snapshot.get("external_agent_id")
            for item in tombstones
        )
    )


def _removal_summary(auxiliary: dict[str, Any]) -> dict[str, Any]:
    records = auxiliary.get("removals") or []
    if not records:
        return {"state": "none", "count": 0}
    return {
        "state": "completed" if any(item.get("completed_at") for item in records) else "retained",
        "count": len(records),
        "attemptIds": sorted(str(item.get("attempt_id") or "") for item in records),
        "placementEpochs": sorted(
            item.get("placement_epoch")
            for item in records
            if type(item.get("placement_epoch")) is int
        ),
        "archiveSha256": sorted(
            _digest(item.get("archive")) for item in records if item.get("archive") is not None
        ),
    }


def _claim_metadata(claim: dict[str, Any]) -> dict[str, Any]:
    value = claim.get("backend_metadata")
    return value if isinstance(value, dict) else {}


def _claim_project(claim: Any) -> str | None:
    if not isinstance(claim, dict):
        return None
    metadata = _claim_metadata(claim)
    project = metadata.get("project") or metadata.get("user_cloud_project")
    if isinstance(project, str) and project:
        return project
    snapshot = metadata.get("erasure", {}).get("registrySnapshot")
    if isinstance(snapshot, dict):
        snapshot_metadata = snapshot.get("backend_metadata") or {}
        project = snapshot_metadata.get("project") or snapshot.get("user_cloud_project")
        return project if isinstance(project, str) and project else None
    return None


def _claim_attempt_id(claim: dict[str, Any]) -> str | None:
    attempt = _claim_metadata(claim).get("provisionAttempt")
    value = attempt.get("attemptId") if isinstance(attempt, dict) else None
    return value if isinstance(value, str) and value else None


def _claim_service(claim: dict[str, Any]) -> str | None:
    metadata = _claim_metadata(claim)
    value = metadata.get("service") or claim.get("external_agent_id")
    return value if isinstance(value, str) and value else None


def _retained_hosted_service_expectation(
    claim: Any, *, owner_id: str, project_id: str, project_number: str
) -> dict[str, str] | None:
    if not isinstance(claim, dict):
        return None
    metadata = _claim_metadata(claim)
    attempt = metadata.get("provisionAttempt")
    if not isinstance(attempt, dict):
        return None
    admission = attempt.get("hostedAdmission")
    assignment = admission.get("assignment") if isinstance(admission, dict) else None
    evidence = attempt.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    reserved = evidence.get("reserved")
    reserved = reserved if isinstance(reserved, dict) else {}
    project_observation = reserved.get("projectObservation")
    project_observation = project_observation if isinstance(project_observation, dict) else {}
    host_requested = evidence.get("host_requested")
    host_requested = host_requested if isinstance(host_requested, dict) else {}
    acknowledgement = host_requested.get("creationAcknowledgement")
    acknowledgement = acknowledgement if isinstance(acknowledgement, dict) else {}
    intent = attempt.get("intent")
    intent = intent if isinstance(intent, dict) else {}

    retained_owner_id = claim.get("user_id")
    hushh_id = claim.get("hushh_id")
    service = _claim_service(claim)
    attempt_id = _claim_attempt_id(claim)
    service_uid = acknowledgement.get("serviceUid")
    runtime_principal = metadata.get("runtime_service_account")
    image_digest = admission.get("imageDigest") if isinstance(admission, dict) else None
    region = metadata.get("region")
    if (
        not isinstance(owner_id, str)
        or not owner_id
        or not isinstance(hushh_id, str)
        or not hushh_id
        or not isinstance(service, str)
        or not service
        or not isinstance(attempt_id, str)
        or not attempt_id
        or not isinstance(service_uid, str)
        or not service_uid
        or not isinstance(runtime_principal, str)
        or not runtime_principal
        or not isinstance(image_digest, str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest)
        or not isinstance(region, str)
        or not region
        or (retained_owner_id is not None and retained_owner_id != owner_id)
        or attempt.get("ownerId") != owner_id
        or intent.get("user_id") != owner_id
        or intent.get("hushh_id") != hushh_id
        or not isinstance(assignment, dict)
        or assignment.get("ownerHash") != _owner_hash(owner_id)
        or assignment.get("project") != project_id
        or (
            assignment.get("projectNumber") is not None
            and str(assignment.get("projectNumber")) != project_number
        )
        or metadata.get("project") != project_id
        or project_observation.get("projectId") != project_id
        or str(project_observation.get("projectNumber")) != project_number
        or acknowledgement.get("backend") != "gcp"
        or acknowledgement.get("project") != project_id
        or acknowledgement.get("region") != region
        or acknowledgement.get("service") != service
        or acknowledgement.get("initialImage")
        != f"{region}-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@{image_digest}"
        or metadata.get("serviceUid", service_uid) != service_uid
    ):
        return None
    return {
        "projectId": project_id,
        "projectNumber": project_number,
        "service": service,
        "attemptId": attempt_id,
        "serviceUid": service_uid,
        "imageDigest": image_digest,
        "runtimePrincipal": runtime_principal,
        "image": f"{region}-docker.pkg.dev/{project_id}/one-pod/consent-protocol-pod@{image_digest}",
    }


def _retained_hosted_service_matches(service: Any, expected: dict[str, str]) -> bool:
    if not isinstance(service, dict):
        return False
    metadata, labels, template_spec, container = _service_parts(service)
    image = container.get("image")
    return bool(
        metadata.get("name") == expected["service"]
        and metadata.get("namespace") == expected["projectNumber"]
        and metadata.get("uid") == expected["serviceUid"]
        and labels.get("app") == "hussh-one-pod"
        and labels.get("hussh-tenancy") == "hussh-hosted"
        and labels.get("hussh-provision-attempt") == expected["attemptId"]
        and template_spec.get("serviceAccountName") == expected["runtimePrincipal"]
        and image == expected["image"]
    )


def _claim_is_owner_owned(claim: dict[str, Any]) -> bool:
    metadata = _claim_metadata(claim)
    return bool(
        claim.get("backend") == "user_gcp"
        or metadata.get("tenancy") == "user-owned"
        or metadata.get("user_cloud_project")
        or claim.get("deployment_target") in {"user_gcp", "user_azure"}
    )


def _claim_is_hosted(claim: dict[str, Any]) -> bool:
    metadata = _claim_metadata(claim)
    return bool(
        metadata.get("tenancy") == "hussh-hosted"
        or isinstance(metadata.get("provisionAttempt"), dict)
        and isinstance(metadata["provisionAttempt"].get("hostedAdmission"), dict)
    )


def _claim_summary(claim: dict[str, Any]) -> dict[str, Any]:
    return {
        "hushhId": claim.get("hushh_id"),
        "source": claim.get("claim_source"),
        "status": claim.get("status"),
        "projectId": _claim_project(claim),
        "service": _claim_service(claim),
        "attemptId": _claim_attempt_id(claim),
        "hostingClass": "owner_owned"
        if _claim_is_owner_owned(claim)
        else "hosted"
        if _claim_is_hosted(claim)
        else "unclassified",
    }


def _creation_recovery_ready(row: dict[str, Any] | None) -> bool:
    if not isinstance(row, dict):
        return False
    attempt = _attempt(row)
    evidence = attempt.get("evidence") if isinstance(attempt.get("evidence"), dict) else {}
    completed = (
        evidence.get("reserved", {}).get("hostedPreparation", {}).get("completed")
        if isinstance(evidence.get("reserved"), dict)
        else None
    )
    return bool(
        row.get("status") == "provisioning"
        and attempt.get("phase") == "host_requested"
        and not evidence.get("host_requested", {}).get("creationAcknowledgement")
        and isinstance(completed, list)
        and len(completed) == 5
        and all(isinstance(item, dict) and item.get("ok") is True for item in completed)
    )


def _safe_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"status": "completed"}
    safe = {}
    for key in ("status", "phase", "generation", "attemptId", "noOp", "rowDeleteDeferred"):
        if isinstance(value.get(key), (str, int, bool)):
            safe[key] = value[key]
    return safe or {"status": "completed"}


if __name__ == "__main__":
    raise SystemExit(main())
