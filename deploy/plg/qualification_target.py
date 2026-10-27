"""Fixed, private Dev/UAT resources for the recorded PLG source only.

These resources are qualification targets, never shared-environment acceptance
or authority to promote production traffic. No cloud reads happen on import.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

SOURCE = "5de6ee29abe3b00642bd6b745c608279091810b3"
BASELINE = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
POLICY_SHA256 = "39ade7f9e38ca0409e2d8c4a2017f5014da41fb7030699aca8863a2c2d29b4ce"
# Leave room for the existing 13-character per-attempt candidate tag.
SERVICE = "consent-protocol-plg-qual"
DATABASE = "plg_qualification"
RUNTIME_ROLE = "plg_qualification_runtime"
MIGRATOR_ROLE = "plg_qualification_migrator"
PREFIX = "PLG_QUALIFICATION_"
MARKER = "plg-isolated-qualification-v1:" + SOURCE
ABSENT_TABLES = (
    "account_phone_transfers",
    "account_phone_auth_fences",
    "account_phone_recovery_continuations",
    "account_device_actions",
)
RUNTIME_SECRETS = (
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "DB_USER",
    "DB_PASSWORD",
    "BACKEND_RUNTIME_CONFIG_JSON",
)
MIGRATOR_SECRETS = ("MIGRATOR_DB_USER", "MIGRATOR_DB_PASSWORD")
TARGETS = {
    "dev": ("hushh-pda-dev", "plg-qualification-pg", 6546),
    "uat": ("hushh-pda-uat", "hushh-uat-pg", 6547),
}


class QualificationError(ValueError):
    """A fixed, nonsecret prerequisite or refusal code."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise QualificationError(code)


@dataclass(frozen=True)
class Target:
    environment: str

    def __post_init__(self):
        require(self.environment in TARGETS, "qualification_environment_invalid")

    @property
    def project(self) -> str:
        return TARGETS[self.environment][0]

    @property
    def instance(self) -> str:
        return f"{self.project}:us-central1:{TARGETS[self.environment][1]}"

    @property
    def proxy_port(self) -> int:
        return TARGETS[self.environment][2]

    @property
    def runtime_sa(self) -> str:
        return f"plg-qualification-runtime@{self.project}.iam.gserviceaccount.com"

    @property
    def labels(self) -> dict[str, str]:
        return {"purpose": "plg-qualification", "plg-source": SOURCE}

    def runtime_config(self) -> dict:
        # No copied config bundle: absence of OAuth/mail/provider material is
        # deliberate. Shared Firebase authentication may be qualified separately;
        # it does not authorize shared DB/events/analytics or production keys.
        return {
            "environment": "uat",
            "db_name": DATABASE,
            "db_host": "",
            "db_unix_socket": "/cloudsql/" + self.instance,
            "sync_remote_enabled": False,
            "gmail_chat_reads": False,
            "google_drive_chat_reads": False,
            "google_drive_live": False,
            "drive_work_drain_enabled": False,
            "mail_scheduled_drain_enabled": False,
            "one_voice_mail_reply_enabled": False,
            "one_voice_mail_schedule_send_enabled": False,
            "one_voice_mail_drafts_enabled": False,
            "email_auth_enabled": False,
            "one_plg_export_enabled": False,
            "one_plg_activity_enabled": False,
            "one_plg_activity_all_registered": False,
            "one_plg_audience_enabled": False,
            "one_plg_subscription_enabled": False,
        }

    def plan(self) -> dict:
        return {
            "schemaVersion": 1,
            "kind": "plg-isolated-qualification-target-v1",
            "environment": self.environment,
            "project": self.project,
            "region": "us-central1",
            "service": SERVICE,
            "instance": self.instance,
            "database": DATABASE,
            "runtimeRole": RUNTIME_ROLE,
            "migratorRole": MIGRATOR_ROLE,
            "runtimePrincipal": self.runtime_sa,
            "sourceSha": SOURCE,
            "baselineSha": BASELINE,
            "authorityPolicySha256": POLICY_SHA256,
            "providerContractVersion": 2,
            "requiredAbsentTables": list(ABSENT_TABLES),
            "runtimeSecrets": [PREFIX + name for name in RUNTIME_SECRETS],
            "migrationSecrets": [PREFIX + name for name in MIGRATOR_SECRETS],
            "maxInstances": 1,
            "runtimeConnectionLimit": 8,
            "trafficAuthorized": False,
            "environmentAccepted": False,
            "prerequisites": [
                "governed_environment_identity_and_capacity",
                "dedicated_database_administrator_material",
                "reviewed_synthetic_foundation_contract",
                "actual_d8_schema_and_provider2_verification",
                "source_validation_and_immutable_image_provenance",
                "separate_runtime_cloudsql_and_selected_provider_permissions",
            ],
        }

    def service_document(
        self, image: str, versions: dict[str, str], run_id: str
    ) -> dict:
        require(
            re.fullmatch(
                r"gcr\.io/"
                + re.escape(self.project)
                + r"/consent-protocol@sha256:[0-9a-f]{64}",
                image,
            )
            is not None,
            "qualification_image_reference_invalid",
        )
        require(
            re.fullmatch(r"[1-9][0-9]*", run_id) is not None,
            "qualification_run_id_invalid",
        )
        require(
            set(versions) == set(RUNTIME_SECRETS)
            and all(
                isinstance(v, str) and re.fullmatch(r"[1-9][0-9]*", v)
                for v in versions.values()
            ),
            "qualification_secret_versions_invalid",
        )
        return {
            "apiVersion": "serving.knative.dev/v1",
            "kind": "Service",
            "metadata": {
                "name": SERVICE,
                "namespace": self.project,
                "labels": self.labels,
                "annotations": {
                    "run.googleapis.com/invoker-iam-disabled": "false",
                    "run.googleapis.com/maxScale": "1",
                },
            },
            "spec": {
                "template": {
                    "metadata": {
                        "labels": self.labels | {"deploy-sha": SOURCE},
                        "annotations": {
                            "run.googleapis.com/cloudsql-instances": self.instance,
                            "autoscaling.knative.dev/minScale": "0",
                            "autoscaling.knative.dev/maxScale": "1",
                        },
                    },
                    "spec": {
                        "serviceAccountName": self.runtime_sa,
                        "containerConcurrency": 2,
                        "timeoutSeconds": 300,
                        "containers": [
                            {
                                "image": image,
                                "resources": {"limits": {"cpu": "2", "memory": "2Gi"}},
                                "env": self._runtime_env(versions, run_id),
                            }
                        ],
                    },
                }
            },
        }

    def _runtime_env(self, versions: dict[str, str], run_id: str) -> list[dict]:
        plain = {
            "ENVIRONMENT": "uat",
            "GOOGLE_CLOUD_PROJECT": self.project,
            "DB_NAME": DATABASE,
            "DB_HOST": "",
            "DB_UNIX_SOCKET": "/cloudsql/" + self.instance,
            "WEB_CONCURRENCY": "1",
            "DB_POOL_MIN_SIZE": "1",
            "DB_POOL_MAX_SIZE": "4",
            "DB_SQLALCHEMY_POOL_SIZE": "1",
            "DB_SQLALCHEMY_MAX_OVERFLOW": "0",
            "REQUIRE_DATABASE_ON_STARTUP": "true",
            "APP_REVIEW_MODE": "false",
            "ACCOUNT_GENERATION_ADMISSION_ENABLED": "false",
            "ONE_FEED_ATTENTION_PUSH_ENABLED": "false",
            "EMAIL_AUTH_ENABLED": "false",
            "HUSHH_DEPLOY_ENV": self.environment,
            "HUSHH_DEPLOY_SOURCE": "plg-isolated-qualification",
            "HUSHH_DEPLOY_SHA": SOURCE,
            "HUSHH_DEPLOY_RUN_ID": run_id,
        }
        return [{"name": name, "value": value} for name, value in plain.items()] + [
            {
                "name": name,
                "valueFrom": {
                    "secretKeyRef": {"name": PREFIX + name, "key": versions[name]}
                },
            }
            for name in RUNTIME_SECRETS
        ]


def config_bytes(target: Target) -> bytes:
    return json.dumps(
        target.runtime_config(), sort_keys=True, separators=(",", ":")
    ).encode()
