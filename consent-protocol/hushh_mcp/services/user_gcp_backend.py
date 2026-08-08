"""User-owned GCP backend (BYOC) — the pod runs in the USER's own cloud.

This is the sovereignty flagship: instead of Hushh hosting the per-user pod, the
user runs it in **their own GCP project**, so the compute *and* the storage are
literally theirs — Hushh never holds their data, not even encrypted-at-our-vault.
It is the same slim pod image and the same ``ComputeBackend`` contract as
``GcpBackend``; only the **target project** and the **credential model** differ.

**Tenancy tier, not the mass default.** Most consumers do not have (or want to pay
for) a GCP project, so BYOC is the prosumer / enterprise / "own your compute" tier;
the mass tier stays Hushh-hosted (``GcpBackend``) and the endgame is the user's own
hardware (edge / Puppy One). All three sit on this one seam.

**Keyless by construction (least privilege).** Hushh never holds standing
credentials *into* the user's project. Instead the user authorizes a **one-time,
least-privilege bootstrap** (rendered by ``render_bootstrap_plan``) that stands up,
in *their* project: a per-user KMS key, a per-user-encrypted GCS bucket, a
least-privilege pod service account, the Cloud Run pod (the slim image), a
per-user mail-event trigger (Gmail ``watch`` -> Pub/Sub, daily-renewed), a
**Workload Identity Federation** trust so Hushh's consent-plane identity is
*federated in* (no SA key is exported), and a ``run.invoker`` grant so only the
Hushh A2A gateway can reach the pod. From then on Hushh authenticates *to* the pod
via federation; the pod calls *back* to Hushh's consent MCP with a per-user HCT.
The consent authority stays central; the pod holds only its own X25519 key.

**Inert by default.** Plan/dry-run mode renders the deploy artifact + the bootstrap
plan but makes **no call into any user project**. Live execution is gated behind
``HUSSH_USER_GCP_LIVE`` + a completed WIF bootstrap and raises until that external
setup exists (a user project + federation cannot be mocked into being).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_USER_GCP,
    BackendHandle,
    BackendStatus,
    PodSpec,
)
from hushh_mcp.services.gcp_backend import (
    A2A_ADDRESS_BASE,
    GcpBackend,
    _env,
    _flag,
    _service_name,
)

logger = logging.getLogger(__name__)

_SLUG = re.compile(r"[^a-z0-9-]+")


def _slug(hushh_id: str) -> str:
    return _SLUG.sub("-", str(hushh_id or "").lower()).strip("-")[:40]


class UserGcpBackend:
    """Provision a user's agent in the USER's own GCP project (BYOC), keyless."""

    backend_id = BACKEND_USER_GCP

    def __init__(
        self,
        *,
        user_project: Optional[str] = None,
        user_region: Optional[str] = None,
        image: Optional[str] = None,
        wif_pool: Optional[str] = None,
        wif_provider: Optional[str] = None,
        hushh_invoker_sa: Optional[str] = None,
        min_instances: Optional[int] = None,
        live: Optional[bool] = None,
    ) -> None:
        self._user_project = (
            user_project if user_project is not None else _env("HUSSH_USER_GCP_PROJECT")
        )
        self._user_region = (
            user_region
            if user_region is not None
            else (_env("HUSSH_USER_GCP_REGION") or "us-central1")
        )
        self._image = image if image is not None else _env("HUSSH_ONE_POD_IMAGE")
        # Workload Identity Federation coordinates (keyless trust into the project).
        self._wif_pool = wif_pool if wif_pool is not None else _env("HUSSH_USER_GCP_WIF_POOL")
        self._wif_provider = (
            wif_provider if wif_provider is not None else _env("HUSSH_USER_GCP_WIF_PROVIDER")
        )
        # The Hushh consent-plane identity that the user grants run.invoker to.
        self._hushh_invoker_sa = (
            hushh_invoker_sa if hushh_invoker_sa is not None else _env("HUSSH_CONSENT_PLANE_SA")
        )
        self._live = bool(live) if live is not None else _flag("HUSSH_USER_GCP_LIVE")
        # Reuse the GCP renderer, pinned to the USER's project/region (never live here;
        # the inner backend only renders — this class owns provisioning semantics).
        self._inner = GcpBackend(
            project=self._user_project,
            region=self._user_region,
            image=self._image,
            min_instances=min_instances,
            live=False,
        )

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        """The Cloud Run service for the pod — rendered against the USER's project."""
        cfg: dict[str, Any] = self._inner.render_deploy_config(spec)
        # Mark tenancy so the artifact is unambiguously user-owned.
        cfg["metadata"]["labels"]["hussh-tenancy"] = "user-owned"
        return cfg

    def render_bootstrap_plan(self, spec: PodSpec) -> dict[str, Any]:
        """The least-privilege setup the USER authorizes in THEIR project (keyless).

        A declarative plan (the contract a Terraform/Deployment-Manager module — or
        the user's own device Agent One over MCP — applies). Hushh holds no standing
        credential into the project: it is federated in via WIF and invited as an
        invoker on exactly the pod service.
        """
        slug = _slug(spec.hushh_id)
        name = _service_name(spec.hushh_id)
        project = self._user_project or "<user-project>"
        pod_sa = f"one-pod-{slug}@{project}.iam.gserviceaccount.com"
        kms_key = f"one-pod-{slug}-key"
        bucket = f"one-pod-{slug}-blobs"
        invoker = self._hushh_invoker_sa or "<hushh-consent-plane-sa>"
        # Per-user mail-event trigger, entirely inside the user's project (BYOC): Gmail
        # push -> the user's OWN Pub/Sub topic; the always-on pod pulls its own wake
        # events. A metadata-only doorbell -- the pod opens the mail, never Hushh.
        mail_topic = f"one-mail-{slug}"
        mail_sub = f"one-mail-{slug}-sub"
        watch_job = f"one-mail-{slug}-watch-renew"
        return {
            "tenancy": "user-owned",
            "target": {"project": project, "region": self._user_region},
            "resources": [
                {
                    "type": "kms_key",
                    "id": kms_key,
                    "purpose": "per-user CMEK for PKM cache + blobs",
                },
                {
                    "type": "gcs_bucket",
                    "id": bucket,
                    "purpose": "per-user-encrypted blob storage near the agent",
                    "encryption": f"cmek:{kms_key}",
                },
                {
                    "type": "service_account",
                    "id": pod_sa,
                    "purpose": "least-privilege pod runtime identity",
                },
                {
                    "type": "cloud_run_service",
                    "id": name,
                    "image": self._image or "<slim-pod-image>",
                    "ingress": "internal",
                    "service_account": pod_sa,
                    "purpose": "the sovereign per-user pod (slim image)",
                },
                {
                    "type": "pubsub_topic",
                    "id": mail_topic,
                    "purpose": "Gmail push target — mailbox-change events (metadata only, no body)",
                },
                {
                    "type": "pubsub_subscription",
                    "id": mail_sub,
                    "on": mail_topic,
                    "delivery": (
                        "pull, consumed by the always-on pod "
                        "(push-to-/wake is the alternative when fronted by the gateway)"
                    ),
                    "purpose": "wakes the pod on new mail; the pod then fetches changes with the user's own token",
                },
                {
                    "type": "cloud_scheduler_job",
                    "id": watch_job,
                    "schedule": "daily",
                    "purpose": "re-arm Gmail users.watch() before its 7-day expiry (fail-safe: history catch-up on lapse)",
                },
            ],
            "iam": [
                {"member": pod_sa, "role": "roles/cloudkms.cryptoKeyDecrypter", "on": kms_key},
                {"member": pod_sa, "role": "roles/storage.objectAdmin", "on": bucket},
                {
                    "member": invoker,
                    "role": "roles/run.invoker",
                    "on": name,
                    "note": "lets ONLY the Hushh A2A gateway reach the pod; Hushh holds no key into this project",
                },
                {
                    "member": "gmail-api-push@system.gserviceaccount.com",
                    "role": "roles/pubsub.publisher",
                    "on": mail_topic,
                    "note": "lets Gmail publish mailbox-change events into the user's OWN topic",
                },
                {
                    "member": pod_sa,
                    "role": "roles/pubsub.subscriber",
                    "on": mail_sub,
                    "note": "the always-on pod pulls its own wake events; no event leaves the user's project",
                },
            ],
            "federation": {
                "type": "workload_identity_federation",
                "pool": self._wif_pool or "<wif-pool>",
                "provider": self._wif_provider or "<wif-provider>",
                "note": "keyless — Hushh's consent-plane identity is federated in; no SA key leaves the user's project",
            },
            "tunnel": {
                "inbound": "Hushh A2A gateway -> pod (run.invoker, private ingress)",
                "outbound": "pod -> Hushh consent MCP with a per-user HCT (enforcement, not issuance)",
                "zero_knowledge": "pod holds its own X25519 key; Hushh sees ciphertext only",
            },
            "mail_trigger": {
                "model": "provider-native push — the doorbell, not the mail-opener",
                "source": "Gmail users.watch() -> the user's own Pub/Sub topic (Graph webhook is the Outlook parity)",
                "carries": "metadata only — emailAddress + historyId; never the message body",
                "wake": (
                    "the event wakes the always-on pod; the pod fetches the changed messages "
                    "with the user's OWN token and decrypts in-process"
                ),
                "zero_knowledge": (
                    "Hushh is fully out of this path — topic, subscription, token, pod, and mailbox "
                    "all live in the user's project; Hushh sees neither content nor the 'new mail at T' metadata"
                ),
                "renewal": (
                    "Cloud Scheduler re-arms the 7-day watch daily; delivery is at-least-once, so the "
                    "pod dedupes on historyId and reconciles from the last processed point"
                ),
                "alias": (
                    "plus-addressing (alice+one@) keeps agent-directed mail in the user's own single "
                    "mailbox — no extra account, no Hushh-owned inbox"
                ),
                "not_mcp": (
                    "MCP tools are the agent's hands (read/draft/send after wake), not the trigger — "
                    "MCP has no watch/subscribe primitive"
                ),
            },
            "authorization": (
                "user runs the one-time bootstrap (Terraform/gcloud), or their device "
                "Agent One applies it over MCP on Hushh's signed instruction; Hushh never "
                "holds standing broad credentials into the user's project"
            ),
        }

    async def provision(self, spec: PodSpec) -> BackendHandle:
        """Plan mode: describe the planned user-owned pod (no call into any project).

        Live provisioning is gated on ``HUSSH_USER_GCP_LIVE`` + a completed WIF
        bootstrap; it raises until that external setup exists (a real user project +
        federation cannot be mocked)."""
        if self._live:
            raise NotImplementedError(
                "user-GCP live provisioning requires a completed Workload Identity "
                "Federation bootstrap in the user's project (see render_bootstrap_plan); "
                "not yet wired"
            )
        name = _service_name(spec.hushh_id)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="planned",
            backend=self.backend_id,
            backend_metadata={
                "tenancy": "user-owned",
                "project": self._user_project,
                "region": spec.region or self._user_region,
                "service": name,
                "ingress": "internal",
                "bootstrap": "pending",
                "keyless": True,
            },
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            raise NotImplementedError(
                "user-GCP live teardown requires the WIF bootstrap; not yet wired"
            )
        logger.info("user_gcp_backend.plan_deprovision service=%s", external_agent_id)
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self._live:
            raise NotImplementedError(
                "user-GCP live status requires the WIF bootstrap; not yet wired"
            )
        return BackendStatus(
            external_agent_id=(external_agent_id or None), status="planned", healthy=True
        )

    async def health(self) -> bool:
        return True


__all__ = ["UserGcpBackend"]
