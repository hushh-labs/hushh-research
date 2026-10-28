"""Internal controller binding; never an owner-supplied hosting credential."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from hushh_mcp.services.byoc_bootstrap_execution import BootstrapContinuation
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment


@dataclass(frozen=True)
class HostedGcpAuthority:
    deployment: PrivateGcpDeployment
    source_image: str
    bootstrap_sa: str
    check: Callable[[], None] = field(repr=False, compare=False)
    operation: Literal["bootstrap", "provision", "upgrade", "inspect", "cleanup"] = "provision"
    execute: bool = False
    continuation: BootstrapContinuation | None = field(default=None, repr=False, compare=False)

    installed_image: str | None = None
    operation_id: str | None = None

    def __call__(self) -> None:
        self.check()

    def validate_execution(self) -> None:
        self.deployment.validate(frozen=self.operation in {"cleanup", "inspect"})
        if (
            self.execute
            and self.operation in {"bootstrap", "provision"}
            and (
                not isinstance(self.operation_id, str)
                or re.fullmatch(r"[a-f0-9]{32}", self.operation_id) is None
            )
        ):
            raise ValueError("Managed execution requires its retained provision operation")
        project = self.deployment.project
        control_project = self.deployment.hub_principal.split("@", 1)[-1].removesuffix(
            ".iam.gserviceaccount.com"
        )
        if project == control_project or (
            self.deployment.inference_project is not None
            and project == self.deployment.inference_project
        ):
            raise ValueError(
                "Managed owners require projects separate from the shared control/model projects"
            )
        if (
            self.deployment.hosting_mode != "hussh_hosted"
            or self.deployment.environment != "dev"
            or self.deployment.project_number is None
            or not re.fullmatch(
                r"[a-z][a-z0-9-]{4,28}[a-z0-9]@"
                + re.escape(project)
                + r"\.iam\.gserviceaccount\.com",
                self.bootstrap_sa,
            )
            or self.operation not in {"bootstrap", "provision", "upgrade", "inspect", "cleanup"}
        ):
            raise ValueError(
                "Managed execution requires its retained project and bootstrap identity"
            )
        if self.operation != "cleanup" and (
            self.deployment.inference_model is None
            or not self.source_image.startswith("gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:")
            or self.source_image.rsplit("@", 1)[-1] != self.deployment.image.rsplit("@", 1)[-1]
        ):
            raise ValueError("Managed publication source differs from the admitted release")
