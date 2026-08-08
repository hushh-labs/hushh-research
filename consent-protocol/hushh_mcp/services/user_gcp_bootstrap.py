"""Apply ``UserGcpBackend.render_bootstrap_plan`` into the USER'S own GCP project.

The plan has existed as a declarative artifact for a while and nothing consumed it.
This is the consumer: it turns those seven resources and their IAM into real API calls
against a project hushh does not own.

THE CREDENTIAL MODEL, AND A CORRECTION TO THE PLAN'S OWN LANGUAGE
-----------------------------------------------------------------
``render_bootstrap_plan`` describes federation as a **Workload Identity Federation**
pool and provider. For a hushh control plane that runs *outside* Google -- the Anypoint
/ CloudHub deployment is a real part of this architecture -- that is exactly right: WIF
is how a non-Google workload obtains Google credentials without an exported key.

For the GCP-hosted hub it is the wrong primitive, and using it would add a pool and a
provider that buy nothing. Hushh's consent plane is *already* a Google identity
(``consent-protocol-runtime@…``, via the metadata server). A Google identity reaching
another project does not federate; it is granted. So the keyless mechanism here is
**short-lived service-account impersonation**:

* The user creates one least-privilege bootstrap service account in their project and
  grants hushh's consent-plane identity ``roles/iam.serviceAccountTokenCreator`` **on
  that one account** -- not on the project.
* Hushh calls ``iamcredentials.generateAccessToken`` per session, receives a token that
  expires in minutes, applies the plan, and holds nothing afterwards.

Both models are keyless in the sense that matters: no service-account key is ever
created or exported. What neither model removes is *standing authorization* -- the
binding persists until revoked, under WIF exactly as much as under impersonation. The
plan's phrase "no standing credential" is true and worth keeping; "no standing
authority" would not be, and is not claimed. Revocation is one binding removal, which
is the property to hold on to.

INERT BY DEFAULT
----------------
``plan_calls()`` renders the exact requests this would issue and touches nothing, so the
whole applier is reviewable -- and testable -- without a user project in existence.
``apply()`` is the only method that writes, and it needs a token it cannot mint itself.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_BOOTSTRAP_LIFETIME = "900s"  # 15 minutes: long enough to build, short enough to not matter.

#: Roles the user's one-time authorization grants the bootstrap SA, and why each is
#: needed. Listed here so the ask made of a user is legible in one place rather than
#: inferred from the calls below.
BOOTSTRAP_ROLES: tuple[tuple[str, str], ...] = (
    ("roles/cloudkms.admin", "create the per-user CMEK key that seals their history"),
    ("roles/storage.admin", "create the CMEK-encrypted bucket the pod writes to"),
    ("roles/iam.serviceAccountAdmin", "create the pod's own least-privilege identity"),
    ("roles/run.admin", "create the pod service"),
    ("roles/pubsub.admin", "create the mail doorbell topic and subscription"),
    ("roles/cloudscheduler.admin", "re-arm the Gmail watch before its 7-day expiry"),
    ("roles/resourcemanager.projectIamAdmin", "bind the pod SA to exactly those resources"),
)


class BootstrapError(RuntimeError):
    """A bootstrap step failed. Never partially reported as success."""


def mint_bootstrap_token(
    *,
    bootstrap_sa: str,
    session: Any = None,
    source_token: Optional[str] = None,
    lifetime: str = _BOOTSTRAP_LIFETIME,
) -> str:
    """Impersonate the user's bootstrap SA and return a short-lived access token.

    This is the whole keyless story in one call. It fails loudly rather than falling
    back to hushh's own identity: a silent fallback would let the applier keep working
    after the user revoked their grant, which is precisely the control being tested.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    if source_token is None:
        from google.auth.transport.requests import Request  # noqa: PLC0415

        from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: PLC0415

        creds = load_operator_credentials()
        creds.refresh(Request())
        source_token = creds.token

    response = session.post(
        f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{bootstrap_sa}"
        ":generateAccessToken",
        headers={"Authorization": f"Bearer {source_token}", "Content-Type": "application/json"},
        json={
            "scope": ["https://www.googleapis.com/auth/cloud-platform"],
            "lifetime": lifetime,
        },
        timeout=60,
    )
    if getattr(response, "status_code", 0) != 200:
        raise BootstrapError(
            f"could not impersonate {bootstrap_sa} ({getattr(response, 'status_code', '?')}). "
            "The user's grant of roles/iam.serviceAccountTokenCreator is missing or "
            f"revoked: {getattr(response, 'text', '')[:200]}"
        )
    return str(response.json()["accessToken"])


class UserGcpBootstrap:
    """Turns a rendered bootstrap plan into resources in the user's project."""

    def __init__(
        self,
        *,
        project: str,
        region: str = "us-central1",
        token: Optional[str] = None,
        session: Any = None,
    ) -> None:
        if not project:
            raise BootstrapError("a target project is required; BYOC never guesses one")
        self._project = project
        self._region = region
        self._token = token
        if session is None:
            import requests as session  # noqa: PLC0415
        self._session = session

    # -- rendering (writes nothing) ------------------------------------------------

    def plan_calls(self, plan: dict[str, Any]) -> list[dict[str, Any]]:
        """Every request ``apply`` would make, in order, as inspectable data.

        Kept separate from execution so the blast radius of a bootstrap can be read
        and diffed before anyone points it at a real person's cloud.
        """
        project, region = self._project, self._region
        by_type = {r["type"]: r for r in plan.get("resources", [])}
        keyring = "hushh-one"
        kms_key = by_type.get("kms_key", {}).get("id", "")
        bucket = by_type.get("gcs_bucket", {}).get("id", "")
        pod_sa = by_type.get("service_account", {}).get("id", "")
        pod_sa_id = pod_sa.split("@")[0] if pod_sa else ""
        topic = by_type.get("pubsub_topic", {}).get("id", "")
        sub = by_type.get("pubsub_subscription", {}).get("id", "")
        job = by_type.get("cloud_scheduler_job", {}).get("id", "")
        key_path = (
            f"projects/{project}/locations/{region}/keyRings/{keyring}/cryptoKeys/{kms_key}"
        )

        calls: list[dict[str, Any]] = [
            {
                "step": "kms_keyring",
                "method": "POST",
                "url": f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/{region}/keyRings",
                "params": {"keyRingId": keyring},
                "body": {},
                "tolerate": [409],
            },
            {
                "step": "kms_key",
                "method": "POST",
                "url": (
                    f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/"
                    f"{region}/keyRings/{keyring}/cryptoKeys"
                ),
                "params": {"cryptoKeyId": kms_key},
                "body": {"purpose": "ENCRYPT_DECRYPT"},
                "tolerate": [409],
            },
            {
                "step": "pod_service_account",
                "method": "POST",
                "url": f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts",
                "body": {
                    "accountId": pod_sa_id,
                    "serviceAccount": {
                        "displayName": "hussh Agent One pod",
                        "description": "Least-privilege runtime identity for this person's pod.",
                    },
                },
                "tolerate": [409],
            },
            {
                # The bucket is created AFTER the key, and names it: a bucket made first
                # would be unencrypted at rest under the user's own key, and switching
                # default encryption later does not re-encrypt what is already written.
                "step": "cmek_bucket",
                "method": "POST",
                "url": "https://storage.googleapis.com/storage/v1/b",
                "params": {"project": project},
                "body": {
                    "name": bucket,
                    "location": region.upper(),
                    "encryption": {"defaultKmsKeyName": key_path},
                    "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}},
                },
                "tolerate": [409],
            },
            {
                "step": "mail_topic",
                "method": "PUT",
                "url": f"https://pubsub.googleapis.com/v1/projects/{project}/topics/{topic}",
                "body": {},
                "tolerate": [409],
            },
            {
                "step": "mail_subscription",
                "method": "PUT",
                "url": f"https://pubsub.googleapis.com/v1/projects/{project}/subscriptions/{sub}",
                "body": {"topic": f"projects/{project}/topics/{topic}"},
                "tolerate": [409],
            },
            {
                "step": "watch_renew_job",
                "method": "POST",
                "url": (
                    f"https://cloudscheduler.googleapis.com/v1/projects/{project}/locations/"
                    f"{region}/jobs"
                ),
                "body": {
                    "name": f"projects/{project}/locations/{region}/jobs/{job}",
                    "schedule": "0 4 * * *",
                    "timeZone": "Etc/UTC",
                    "pubsubTarget": {
                        "topicName": f"projects/{project}/topics/{topic}",
                        "data": "cmVuZXctd2F0Y2g=",  # "renew-watch"
                    },
                },
                "tolerate": [409],
            },
        ]

        # IAM last, and per-resource rather than project-wide. Each binding names one
        # role on one resource; none of them is a project-level grant, which is the
        # difference between "the pod may read its own bucket" and "the pod may read
        # the user's cloud".
        calls.append(
            {
                "step": "iam_pod_sa_on_key",
                "method": "POST",
                "url": f"https://cloudkms.googleapis.com/v1/{key_path}:setIamPolicy",
                "body": {
                    "policy": {
                        "bindings": [
                            {
                                "role": "roles/cloudkms.cryptoKeyDecrypter",
                                "members": [f"serviceAccount:{pod_sa}"],
                            },
                            {
                                "role": "roles/cloudkms.cryptoKeyEncrypter",
                                "members": [f"serviceAccount:{pod_sa}"],
                            },
                        ]
                    }
                },
                "tolerate": [],
                # A fresh key has no bindings, so writing the policy whole is safe HERE
                # and only here. `merge_binding` is used for anything pre-existing.
                "fresh_resource": True,
            }
        )
        calls.append(
            {
                "step": "iam_pod_sa_on_bucket",
                "method": "PUT",
                "url": f"https://storage.googleapis.com/storage/v1/b/{bucket}/iam",
                "body": {
                    "bindings": [
                        {
                            "role": "roles/storage.objectAdmin",
                            "members": [f"serviceAccount:{pod_sa}"],
                        }
                    ]
                },
                "tolerate": [],
                "fresh_resource": True,
            }
        )
        return calls

    # -- execution -----------------------------------------------------------------

    def apply(self, plan: dict[str, Any], *, dry_run: bool = True) -> dict[str, Any]:
        """Create the plan's resources. ``dry_run`` is the default on purpose.

        Returns a per-step result rather than raising on the first problem, because a
        half-built project is a real state a caller has to reason about and an
        exception loses which half.
        """
        calls = self.plan_calls(plan)
        if dry_run:
            return {"dryRun": True, "project": self._project, "steps": calls}
        if not self._token:
            raise BootstrapError(
                "apply(dry_run=False) needs an impersonated bootstrap token; see "
                "mint_bootstrap_token. It will not fall back to hushh's own identity."
            )

        results: list[dict[str, Any]] = []
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        for call in calls:
            response = self._session.request(
                call["method"],
                call["url"],
                headers=headers,
                params=call.get("params"),
                data=json.dumps(call.get("body") or {}),
                timeout=120,
            )
            code = getattr(response, "status_code", 0)
            ok = code in (200, 201) or code in call.get("tolerate", [])
            results.append(
                {
                    "step": call["step"],
                    "status": code,
                    "ok": ok,
                    "detail": "" if ok else getattr(response, "text", "")[:300],
                }
            )
            logger.info("byoc_bootstrap.step step=%s status=%s ok=%s", call["step"], code, ok)

        failed = [r for r in results if not r["ok"]]
        return {
            "dryRun": False,
            "project": self._project,
            "steps": results,
            "ok": not failed,
            "failed": [r["step"] for r in failed],
        }


def authorization_request(*, project: str, bootstrap_sa: str, consent_plane_sa: str) -> dict[str, Any]:
    """Exactly what to ask a user to run once, stated so they can audit it.

    Deliberately a data structure rather than a prose paragraph: a person handing a
    cloud project to a vendor deserves to see the complete list of what that vendor
    will be able to do, not a summary of it.
    """
    return {
        "project": project,
        "creates": {
            "service_account": bootstrap_sa,
            "purpose": "a bootstrap identity hushh may briefly borrow — never hushh's own",
        },
        "grants_to_bootstrap_sa": [
            {"role": role, "why": why, "scope": f"project {project}"} for role, why in BOOTSTRAP_ROLES
        ],
        "grants_to_hushh": [
            {
                "member": f"serviceAccount:{consent_plane_sa}",
                "role": "roles/iam.serviceAccountTokenCreator",
                "on": bootstrap_sa,
                "why": (
                    "lets hushh mint a 15-minute token for THAT ONE account. Not a project "
                    "role, not a key, and revocable by deleting this single binding."
                ),
            }
        ],
        "hushh_never_receives": [
            "a service-account key file",
            "a project-level role",
            "the KMS key material, or the data key it wraps",
            "read access to the pod's bucket contents",
        ],
        "revocation": (
            f"Remove the serviceAccountTokenCreator binding on {bootstrap_sa}, or delete that "
            "service account. hushh loses the ability to change anything in this project "
            "immediately; the pod keeps running on its own identity until you delete it."
        ),
    }


__all__ = [
    "BOOTSTRAP_ROLES",
    "BootstrapError",
    "UserGcpBootstrap",
    "authorization_request",
    "mint_bootstrap_token",
]
