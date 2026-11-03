#!/usr/bin/env python3
"""Guarded operator entrypoint for the two reviewed Dev billing placements.

The report-only inventory is the review artifact. Mutations require its exact
canonical SHA, an explicit Dev environment, and ``--apply``. Every action is
delegated to the existing hosted lifecycle services and journals.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.hosted_provider_account_transition import (
    PLACEMENTS,
    TRANSITION_ACTOR_PRINCIPAL,
)
from scripts.ops.hosted_provider_account_identity import (
    CENTRAL_PROJECT,
    EXPECTED_OPERATOR,
    REVIEWED_FOLDER_ID,
    InventorySnapshot,
    OperatorRefused,
    OperatorRuntime,
    execute_action,
    require_mutation_confirmation,
)
from scripts.ops.hosted_provider_account_lifecycle import NamedGcloudOperatorCredentials


class HostedProviderAccountNativeReader:
    def __init__(self, credentials: Any, session: Any) -> None:
        self.credentials = credentials
        self.session = session

    def project_reader(self, *, project: str, number: str) -> Any:
        from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory

        reader = NativeProjectInventory(
            project=project,
            number=number,
            token=self.access_token(),
            session=self.session,
        )
        reader._headers["x-goog-user-project"] = CENTRAL_PROJECT
        return reader

    def run_client(self, *, project: str, region: str) -> Any:
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        class DevQuotaRunClient(GcpRunClient):
            def _headers(inner_self) -> dict[str, str]:
                headers = super(DevQuotaRunClient, inner_self)._headers()
                headers["x-goog-user-project"] = CENTRAL_PROJECT
                return headers

        return DevQuotaRunClient(project=project, region=region, credentials=self.credentials)

    def access_token(self) -> str:
        from google.auth.transport.requests import Request

        if not getattr(self.credentials, "valid", False):
            self.credentials.refresh(Request(session=self.session))
        token = getattr(self.credentials, "token", None)
        if not isinstance(token, str) or not token:
            raise OperatorRefused("Dev inventory credential is unavailable")
        return token

    def discover_projects(self) -> list[dict[str, Any]]:
        projects: list[dict[str, Any]] = []
        seen: set[str] = set()
        page_token = ""
        headers = {
            "Authorization": "Bearer " + self.access_token(),
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
    operator_credentials = {
        TRANSITION_ACTOR_PRINCIPAL: NamedGcloudOperatorCredentials(
            principal=TRANSITION_ACTOR_PRINCIPAL
        ),
        EXPECTED_OPERATOR: NamedGcloudOperatorCredentials(),
    }
    return HostedProviderAccountRuntime(
        credentials=read_credentials,
        operator_credentials=operator_credentials,
        session=requests.Session(),
    )


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
        self._native_reader = HostedProviderAccountNativeReader(credentials, session)
        self.project_reader_factory = project_reader_factory or self._native_reader.project_reader
        self.run_client_factory = run_client_factory or self._native_reader.run_client
        self.transition_factory = transition_factory or self._transition
        self.operator_verifier = operator_verifier or self._verify_operator
        self.project_discovery = project_discovery or self._native_reader.discover_projects

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

        credentials = self.operator_credentials
        if isinstance(credentials, dict):
            credentials = credentials.get(expected)
        if credentials is None:
            raise OperatorRefused("named billing operator credential is unavailable")
        return verify_operator(credentials, self.session, expected=expected)

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

    def _owner_generation(self, owner_id: str) -> int:
        from scripts.ops.hosted_provider_account_evidence import owner_generation

        return owner_generation(self.registry, owner_id)

    async def _retained_records(self, **kwargs: Any) -> dict[str, Any]:
        from scripts.ops.hosted_provider_account_evidence import retained_records

        return await retained_records(self.registry, **kwargs)

    async def inventory(self) -> InventorySnapshot:
        from scripts.ops.hosted_provider_account_inventory import build_inventory

        return await build_inventory(self)

    async def perform(
        self,
        action: str,
        placement: dict[str, Any],
        *,
        reviewed_sha256: str,
        inventory_snapshot: InventorySnapshot | None = None,
    ) -> dict[str, Any]:
        from scripts.ops.hosted_provider_account_lifecycle import perform_action

        return await perform_action(
            self,
            action,
            placement,
            reviewed_sha256=reviewed_sha256,
            inventory_snapshot=inventory_snapshot,
        )

    async def _resume_existing_creation(
        self, *, owner_id: str, row: dict[str, Any], record: dict[str, Any]
    ) -> dict[str, Any]:
        from scripts.ops.hosted_provider_account_lifecycle import resume_existing_creation

        return await resume_existing_creation(self, owner_id=owner_id, row=row, record=record)

    async def _remove_through_retained_erasure(
        self, *, owner_id: str, row: dict[str, Any]
    ) -> dict[str, Any]:
        from scripts.ops.hosted_provider_account_lifecycle import remove_through_retained_erasure

        return await remove_through_retained_erasure(self, owner_id=owner_id, row=row)


if __name__ == "__main__":
    raise SystemExit(main())
