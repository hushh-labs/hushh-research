"""Cloud Run observations used by the durable hosted Files upgrade path."""

from __future__ import annotations

from typing import Any


class HostedFilesRunClientMixin:
    """Keep hosted Files v2 observations separate from the general v1 client."""

    @staticmethod
    def hosted_files_predecessor_observation(
        service: dict[str, Any], *, name: str, expected_uid: str
    ) -> dict[str, Any]:
        from hushh_mcp.services.gcp_run_terminal_observation import (
            hosted_files_predecessor_observation,
        )

        return hosted_files_predecessor_observation(service, name=name, expected_uid=expected_uid)

    @staticmethod
    def hosted_files_settlement_observation(
        service: dict[str, Any],
        *,
        name: str,
        expected_uid: str,
        target_image: str,
        deployed_image: str,
        attempt_id: str,
        expected_generation: int,
        predecessor: dict[str, Any],
    ) -> dict[str, Any]:
        from hushh_mcp.services.gcp_run_terminal_observation import (
            hosted_files_settlement_observation,
        )

        return hosted_files_settlement_observation(
            service,
            name=name,
            expected_uid=expected_uid,
            target_image=target_image,
            deployed_image=deployed_image,
            attempt_id=attempt_id,
            expected_generation=expected_generation,
            predecessor=predecessor,
        )

    def _v2_service_resource(self, name: str) -> str:
        from hushh_mcp.services.gcp_run_read_client import v2_service_resource

        return v2_service_resource(self._project, self._region, name)

    def get_v2_service(self, name: str) -> dict[str, Any]:
        from hushh_mcp.services.gcp_run_read_client import get_v2_service

        return get_v2_service(resource=self._v2_service_resource(name), headers=self._headers())

    def get_v2_revision(self, *, service_name: str, revision_name: str) -> dict[str, Any]:
        from hushh_mcp.services.gcp_run_read_client import get_v2_revision

        return get_v2_revision(
            service_resource=self._v2_service_resource(service_name),
            revision_name=revision_name,
            headers=self._headers(),
        )

    def observe_hosted_files_terminal_failure(
        self,
        *,
        name: str,
        expected_uid: str,
        target_image: str,
        deployed_image: str | None = None,
        attempt_id: str,
        expected_generation: int,
        predecessor: dict[str, Any],
    ) -> dict[str, Any]:
        from hushh_mcp.services.gcp_run_terminal_observation import (
            hosted_files_failure_settlement_observation,
        )

        service = self.get_v2_service(name)
        resource = self._v2_service_resource(name)
        revision_name = service.get("latestCreatedRevision")
        if not isinstance(revision_name, str) or not revision_name.startswith(
            f"{resource}/revisions/"
        ):
            raise RuntimeError("Cloud Run failed revision resource is unavailable")
        revision = self.get_v2_revision(service_name=name, revision_name=revision_name)
        confirmation = self.get_v2_service(name)
        return hosted_files_failure_settlement_observation(
            service,
            revision,
            confirmation,
            name=name,
            expected_service_resource=resource,
            expected_uid=expected_uid,
            target_image=target_image,
            deployed_image=deployed_image,
            attempt_id=attempt_id,
            expected_generation=expected_generation,
            predecessor=predecessor,
        )
