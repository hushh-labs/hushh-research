"""Common private-pod rendering; hosting authority stays with the lifecycle adapter.

This contract is deployment configuration, not attestation or permission to create
resources. Immutable bindings are checked again against provider observations.
Legacy BYOC dry renders may use a tag; executable hosted bindings never may.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

HOSTING_ENV = "HUSSH_POD_GCP_DEPLOYMENT_JSON"
HostingMode = Literal["user_gcp", "hussh_hosted"]


@dataclass(frozen=True)
class PrivateGcpDeployment:
    owner: str
    hosting_mode: HostingMode
    environment: str
    project: str
    region: str
    image: str
    hub_principal: str
    service_uid: str | None = None
    inference_project: str | None = None
    # Resource Manager's immutable mapping, captured independently at admission.
    # Cloud Run v1 returns a numeric namespace even when creation used a project ID.
    project_number: str | None = None

    def validate(self, *, executable: bool = True) -> None:
        from hushh_mcp.services.user_gcp_backend import _slug, pod_service_account_id

        if (
            self.hosting_mode not in {"user_gcp", "hussh_hosted"}
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.owner)
            or not _slug(self.owner)
            or self.environment not in {"dev", "uat", "production"}
            or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", self.project)
            or not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", self.region)
            or not re.fullmatch(
                r"[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]"
                r"\.iam\.gserviceaccount\.com",
                self.hub_principal,
            )
        ):
            raise ValueError("Private pod deployment authority is invalid")
        if executable and not re.fullmatch(
            re.escape(f"{self.region}-docker.pkg.dev/{self.project}/one-pod/")
            + r"consent-protocol-pod@sha256:[a-f0-9]{64}",
            self.image,
        ):
            raise ValueError("Private pod deployment requires its project-local immutable image")
        if self.service_uid is not None and not self.service_uid.strip():
            raise ValueError("Private pod service incarnation is invalid")
        if self.project_number is not None and not re.fullmatch(
            r"[1-9][0-9]{0,19}", self.project_number
        ):
            raise ValueError("Private pod project number is invalid")
        if self.model_project != self.project:
            from hushh_mcp.managed_ai_config import load_profile

            if (
                self.hosting_mode != "hussh_hosted"
                or self.environment != "dev"
                or self.model_project != load_profile("dev")["project"]
            ):
                raise ValueError("Private pod inference project is not admitted")
        # Exercise the same identity constructor as bootstrap and IAM binding.
        pod_service_account_id(self.owner)

    @property
    def runtime_principal(self) -> str:
        from hushh_mcp.services.user_gcp_backend import pod_service_account_id

        return f"{pod_service_account_id(self.owner)}@{self.project}.iam.gserviceaccount.com"

    @property
    def bucket(self) -> str:
        from hushh_mcp.services.user_gcp_backend import _slug

        return f"one-pod-{_slug(self.owner)}-blobs"

    @property
    def kms_key(self) -> str:
        from hushh_mcp.services.user_gcp_backend import _slug

        return (
            f"projects/{self.project}/locations/{self.region}/keyRings/hushh-one/"
            f"cryptoKeys/one-pod-{_slug(self.owner)}-key"
        )

    def encoded(self) -> str:
        self.validate()
        return json.dumps(
            {
                "version": 1,
                "owner": self.owner,
                "hostingMode": self.hosting_mode,
                "environment": self.environment,
                "project": self.project,
                "region": self.region,
                "image": self.image,
                "hubPrincipal": self.hub_principal,
                "serviceUid": self.service_uid,
                "inferenceProject": self.model_project,
                "projectNumber": self.project_number,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    @classmethod
    def decode(cls, raw: str) -> PrivateGcpDeployment:
        try:
            if len(raw) > 4096:
                raise ValueError
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {
                "version",
                "owner",
                "hostingMode",
                "environment",
                "project",
                "region",
                "image",
                "hubPrincipal",
                "serviceUid",
                "inferenceProject",
                "projectNumber",
            }:
                raise ValueError
            if any(
                not isinstance(value[key], str)
                for key in set(value) - {"serviceUid", "projectNumber", "version"}
            ):
                raise ValueError
            if type(value["version"]) is not int or value["version"] != 1:
                raise ValueError
            if value["serviceUid"] is not None and not isinstance(value["serviceUid"], str):
                raise ValueError
            if value["projectNumber"] is not None and not isinstance(value["projectNumber"], str):
                raise ValueError
            deployment = cls(
                owner=value["owner"],
                hosting_mode=value["hostingMode"],
                environment=value["environment"],
                project=value["project"],
                region=value["region"],
                image=value["image"],
                hub_principal=value["hubPrincipal"],
                service_uid=value["serviceUid"],
                inference_project=value["inferenceProject"],
                project_number=value["projectNumber"],
            )
            deployment.validate()
            return deployment
        except (ValueError, TypeError, KeyError):
            raise ValueError("Private pod deployment configuration is invalid") from None

    def verify_observation(self, service: dict[str, Any]) -> None:
        """Check the full Knative service, including environment and ownership.

        Initial create obtains its provider UID separately; maintenance supplies
        the recorded UID. Labels are checked alongside identity and custody.
        """
        self.validate()
        from hushh_mcp.services.gcp_backend import _service_name
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        try:
            metadata = service["metadata"]
            container = service["spec"]["template"]["spec"]["containers"][0]
            runtime = service["spec"]["template"]["spec"]["serviceAccountName"]
            entries = container["env"]
            env = {entry["name"]: entry.get("value") for entry in entries}
            valid = (
                len(env) == len(entries)
                and metadata["name"] == _service_name(self.owner)
                and (
                    metadata["namespace"] == self.project
                    or (
                        self.project_number is not None
                        and metadata["namespace"] == self.project_number
                    )
                )
                and metadata["labels"]["hussh-tenancy"] == self.tenancy
                and runtime == self.runtime_principal
                and container["image"] == self.image
                and (
                    env.get(HOSTING_ENV) == self.encoded()
                    if self.hosting_mode == "hussh_hosted" or HOSTING_ENV in env
                    else True
                )
                and env["HUSSH_ID"] == self.owner
                and env["HUSHH_DEPLOY_ENV"] == self.environment
                and env["GOOGLE_CLOUD_PROJECT"] == self.project
                and env["HUSSH_POD_KMS_KEY"] == self.kms_key
                and env["POD_STORAGE_GCS_BUCKET"] == self.bucket
                and env["HUSSH_POD_USER_ADC_ENABLED"]
                == ("true" if self.hosting_mode == "user_gcp" else "false")
                and not any(key in env for key in FORBIDDEN_PRIVATE_ENV)
                and "HUSSH_POD_MANAGED_MODEL_ENABLED" not in env
                and (
                    self.service_uid is None
                    or GcpRunClient.service_uid(service) == self.service_uid
                )
            )
        except (KeyError, TypeError, IndexError):
            valid = False
        if not valid:
            raise ValueError("Private pod deployed resources differ from admitted authority")

    @property
    def tenancy(self) -> str:
        return "user-owned" if self.hosting_mode == "user_gcp" else "hussh-hosted"

    @property
    def model_project(self) -> str:
        return self.project if self.inference_project is None else self.inference_project


FORBIDDEN_PRIVATE_ENV = frozenset(
    {
        "HUSSH_POD_LOG_KEY",
        "HUSSH_POD_MEMORY_KEY",
        "HUSSH_POD_KEY_MASTER",
        "HUSSH_POD_KEY_MASTER_B64",
    }
)


def hosted_runtime_deployment() -> PrivateGcpDeployment | None:
    """Resolve a configured hosted runtime without granting owner-cloud status.

    Native metadata identity is additionally checked when credentials refresh.
    This marker is reviewed deployment configuration, never remote attestation.
    """
    import os

    raw = os.environ.get(HOSTING_ENV)
    if raw is None:
        return None
    deployment = PrivateGcpDeployment.decode(raw)
    if deployment.hosting_mode != "hussh_hosted":
        return None
    from hushh_mcp.runtime_settings import pod_mode

    if (
        deployment.environment != "dev"
        or not pod_mode()
        or not os.getenv("K_SERVICE")
        or deployment.owner != os.getenv("HUSSH_ID")
        or deployment.project != os.getenv("GOOGLE_CLOUD_PROJECT")
        or deployment.environment != os.getenv("HUSHH_DEPLOY_ENV")
        or deployment.kms_key != os.getenv("HUSSH_POD_KMS_KEY")
        or deployment.bucket != os.getenv("POD_STORAGE_GCS_BUCKET")
        or os.getenv("HUSSH_POD_USER_ADC_ENABLED", "false").lower() not in {"false", "0"}
        or any(name in os.environ for name in FORBIDDEN_PRIVATE_ENV)
        or any(
            os.getenv(name)
            for name in (
                "GCE_METADATA_HOST",
                "GCE_METADATA_ROOT",
                "GCE_METADATA_IP",
                "HUSSH_POD_MANAGED_MODEL_ENABLED",
                "HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON",
            )
        )
    ):
        raise RuntimeError("Hosted pod runtime authority could not be verified")
    return deployment


def render_private_gcp_service(
    config: dict[str, Any],
    *,
    spec: Any,
    deployment: PrivateGcpDeployment,
    immutable: bool,
) -> dict[str, Any]:
    """Apply common custody and runtime configuration to the existing GCP shape."""
    from hushh_mcp.services.pod_inference_bridge import render_inference_bridge
    from hushh_mcp.services.pod_release import browser_qualification_environment
    from hushh_mcp.services.user_gcp_backend import _MANAGED_ONLY_ENV

    if deployment.hosting_mode == "hussh_hosted" and not immutable:
        raise ValueError("Hosted pod rendering requires an immutable deployment")
    # The new managed assignment has a strict admission contract. Legacy BYOC
    # keeps its existing provider lifecycle validators, including inert renders
    # used to inspect an image before the deployment environment is configured.
    if immutable and deployment.hosting_mode == "hussh_hosted":
        deployment.validate()
    expected_target = "user_gcp" if deployment.hosting_mode == "user_gcp" else "gcp"
    if (
        spec.hushh_id != deployment.owner
        or spec.deployment_target not in {None, expected_target}
        or spec.region not in {None, deployment.region}
        or (spec.user_cloud_project and spec.user_cloud_project != deployment.project)
        or (spec.user_cloud_region and spec.user_cloud_region != deployment.region)
    ):
        raise ValueError("Private pod specification differs from assigned resources")
    template = config["spec"]["template"]
    if template["metadata"]["annotations"].get("autoscaling.knative.dev/maxScale") != "1":
        raise ValueError("An owner pod requires one instance; review its hosting configuration")
    config["metadata"]["labels"]["hussh-tenancy"] = deployment.tenancy
    template["spec"]["serviceAccountName"] = deployment.runtime_principal
    container = template["spec"]["containers"][0]
    container["image"] = deployment.image
    controlled = (
        _MANAGED_ONLY_ENV
        | FORBIDDEN_PRIVATE_ENV
        | {
            HOSTING_ENV,
            "HUSSH_POD_USER_ADC_ENABLED",
            "HUSSH_POD_MANAGED_MODEL_ENABLED",
            "HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON",
            "POD_MEMORY_BACKEND",
            "POD_MEMORY_BANK_LOCATION",
        }
    )
    env = [entry for entry in container.get("env", []) if entry["name"] not in controlled]
    env.extend(
        {"name": key, "value": value}
        for key, value in browser_qualification_environment(
            spec.browser_qualification, target_image=deployment.image, host_kind="gcp_cloud_run"
        ).items()
    )
    if deployment.hosting_mode == "user_gcp":
        env.extend(render_inference_bridge(service_account=deployment.runtime_principal))
    env.extend(_private_resource_environment(deployment, immutable=immutable))
    if spec.files_library_enabled:
        from hushh_mcp.services.pod_files.provisioning import configure_new_service

        configure_new_service(
            config,
            owner=deployment.owner,
            project=deployment.project,
            region=deployment.region,
            env=env,
        )
    container["env"] = env
    return config


def _private_resource_environment(
    deployment: PrivateGcpDeployment,
    *,
    immutable: bool,
) -> list[dict[str, Any]]:
    """Build resource-local custody references; no credential values enter the image."""
    from hushh_mcp.services.byoc_key_custody import byoc_key_env
    from hushh_mcp.services.user_gcp_backend import _pod_vertex_location

    values = {
        "POD_STORAGE_BACKEND": "commit_log",
        "POD_DURABLE_IDENTITY_ENABLED": "true",
        "POD_STORAGE_GCS_BUCKET": deployment.bucket,
        "POD_STORAGE_GCS_PREFIX": f"pods/{deployment.owner}",
        "POD_AGENT_MEMORY_ENABLED": "true",
        "POD_MEMORY_BACKEND": "memory_bank",
        "POD_MEMORY_BANK_LOCATION": deployment.region,
        "GOOGLE_CLOUD_PROJECT": deployment.project,
        "GOOGLE_CLOUD_LOCATION": _pod_vertex_location(deployment.region),
        "HUSSH_POD_USER_ADC_ENABLED": "true" if deployment.hosting_mode == "user_gcp" else "false",
        "HUSSH_POD_HUB_CALLER_EMAILS": deployment.hub_principal,
    }
    if immutable and deployment.hosting_mode == "hussh_hosted":
        values[HOSTING_ENV] = deployment.encoded()
    env = [{"name": key, "value": value} for key, value in values.items()]
    env.extend(byoc_key_env(kms_key=deployment.kms_key))
    env.append(
        {
            "name": "APP_SIGNING_KEY",
            "valueFrom": {
                "secretKeyRef": {
                    "name": deployment.runtime_principal.split("@", 1)[0] + "-signing-key",
                    "key": "latest",
                }
            },
        }
    )
    return env
