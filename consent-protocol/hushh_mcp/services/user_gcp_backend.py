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

from hushh_mcp.services.byoc_key_custody import byoc_key_env
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


#: Env the MANAGED tier ships that a BYOC pod must never receive. Two are plaintext
#: keys derived from hushh's master; the third points at hushh's own bucket. Listed by
#: name rather than filtered by pattern, so adding a managed-only variable later is a
#: decision someone makes here instead of an omission nobody notices.
_MANAGED_ONLY_ENV = frozenset(
    {
        "HUSSH_POD_LOG_KEY",
        "HUSSH_POD_MEMORY_KEY",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_BACKEND",
        "POD_AGENT_MEMORY_ENABLED",
    }
)


async def _create_once_iam_settles(create: Any) -> None:
    """Create the pod, retrying ONLY the IAM race the bootstrap opens for itself.

    The bootstrap grants itself ``actAs`` on the pod's service account moments before
    this call uses it, and IAM is eventually consistent. A live run against a real
    project did exactly that and was refused::

        403 Permission 'iam.serviceaccounts.actAs' denied on service account one-pod-...

    The same call, repeated after the binding had propagated, returned 200. So this
    retries that one message and nothing else: a 403 that does not name ``actAs`` is a
    genuine authorization failure -- a revoked grant, a missing role -- and retrying it
    would turn an answer the operator needs into a delay before the same answer.
    """
    import asyncio  # noqa: PLC0415

    delays = UserGcpBackend._ACTAS_BACKOFF_SECONDS
    for attempt, delay in enumerate((*delays, None)):
        try:
            await create()
            return
        except Exception as exc:  # noqa: BLE001 -- narrowed immediately below
            if delay is None or not _is_actas_propagation(exc):
                raise
            logger.info(
                "user_gcp_backend.actas_not_propagated attempt=%s sleeping=%ss",
                attempt + 1,
                delay,
            )
            await asyncio.sleep(delay)


def _is_actas_propagation(exc: Exception) -> bool:
    """Is this the specific, transient 403 that a just-written actAs binding produces?"""
    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) != 403:
        return False
    return "actas" in (getattr(response, "text", "") or "").lower()


class _StaticToken:
    """Adapts an already-minted access token to what ``GcpRunClient`` expects.

    The client refreshes google-auth credentials; a borrowed impersonation token cannot
    be refreshed from inside the pod's own identity, and it does not need to be — it is
    minted per bootstrap session and outlives the work it was minted for. ``refresh`` is
    a no-op rather than an error so the client's normal flow is untouched.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self.valid = True

    def refresh(self, _request: Any) -> None:  # noqa: D401 - deliberate no-op
        return None


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
        # The account in the USER's project that hushh was authorized to impersonate.
        # Never derived from the project name: a guessed identity that happens to exist
        # would be used silently, and the point of the grant is that it was made.
        self._bootstrap_sa = _env("HUSSH_USER_GCP_BOOTSTRAP_SA")
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
        """The Cloud Run service for the pod — rendered against the USER's project.

        Reusing the managed renderer and adjusting it is deliberate: the two tiers must
        differ in exactly the places BYOC requires and nowhere else, and a second
        renderer would drift. But the managed renderer emits hushh's OWN durable block,
        and shipping that into a user's project produced three violations of the thing
        BYOC promises. Rendering it and reading it back is how they were found:

        * ``POD_STORAGE_GCS_BUCKET`` named ``hushh-pda-dev-pod-state`` — the person's
          history would have been written into **hushh's** bucket.
        * ``HUSSH_POD_LOG_KEY`` and ``HUSSH_POD_MEMORY_KEY`` carried plaintext keys
          derived from hushh's HKDF master, sitting in a service description in the
          user's cloud, readable by anyone with ``run.services.get``.
        * ``serviceAccountName`` was unset, so the pod would have run as the project's
          **default compute** account — with none of the least-privilege IAM the
          bootstrap writes, and considerably more besides.

        ``byoc_key_env`` existed to prevent the first two and had no caller. This is it.
        """
        cfg: dict[str, Any] = self._inner.render_deploy_config(spec)
        # Mark tenancy so the artifact is unambiguously user-owned.
        cfg["metadata"]["labels"]["hussh-tenancy"] = "user-owned"

        slug = _slug(spec.hushh_id)
        project = self._user_project or "<user-project>"
        region = spec.region or self._user_region
        container = cfg["spec"]["template"]["spec"]["containers"][0]

        # The pod runs as its own least-privilege identity, the one the bootstrap
        # created and bound to this person's key and bucket.
        cfg["spec"]["template"]["spec"]["serviceAccountName"] = (
            f"one-pod-{slug}@{project}.iam.gserviceaccount.com"
        )

        kept = [e for e in container.get("env", []) if e["name"] not in _MANAGED_ONLY_ENV]
        kept.extend(
            [
                {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
                # The user's own CMEK bucket, created by their own bootstrap.
                {"name": "POD_STORAGE_GCS_BUCKET", "value": f"one-pod-{slug}-blobs"},
                {"name": "POD_STORAGE_GCS_PREFIX", "value": f"pods/{spec.hushh_id}"},
                {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
            ]
        )
        # Two addresses in place of two secrets. The pod mints and wraps its own key on
        # first boot; the memory key is derived from it inside the pod.
        kept.extend(
            byoc_key_env(
                kms_key=(
                    f"projects/{project}/locations/{region}"
                    f"/keyRings/hushh-one/cryptoKeys/one-pod-{slug}-key"
                )
            )
        )
        container["env"] = kept
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
                # Two mechanisms, chosen by WHERE the hushh control plane runs. Both are
                # keyless in the sense that matters -- no service-account key is ever
                # created or exported -- and neither removes standing *authorization*,
                # which persists under either until the binding is revoked.
                #
                # `impersonation` is correct for the GCP-hosted hub, which is already a
                # Google identity: a Google principal reaching another project is granted,
                # not federated, and a WIF pool would add a component that buys nothing.
                # `workload_identity_federation` is correct for a control plane running
                # OUTSIDE Google (the Anypoint / CloudHub deployment), which has no Google
                # identity to grant and must exchange one.
                "type": "impersonation" if self._hushh_invoker_sa else "workload_identity_federation",
                "impersonation": {
                    "bootstrap_service_account": f"one-bootstrap-{slug}@{project}.iam.gserviceaccount.com",
                    "granted_to": invoker,
                    "role": "roles/iam.serviceAccountTokenCreator",
                    "scope": "that ONE service account — never a project-level role",
                    "token_lifetime": "900s",
                    "note": (
                        "hushh mints a 15-minute token per bootstrap session and holds "
                        "nothing afterwards; revocation is removing this single binding"
                    ),
                },
                "workload_identity_federation": {
                    "pool": self._wif_pool or "<wif-pool>",
                    "provider": self._wif_provider or "<wif-provider>",
                    "applies_to": "a non-Google control plane (CloudHub); unused by the GCP hub",
                },
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
        """Create the pod in the USER's project, or describe it when not live.

        Live provisioning needs ``HUSSH_USER_GCP_LIVE`` **and** a completed bootstrap:
        the pod's service account, its CMEK bucket and its wrapped log key all come
        from ``UserGcpBootstrap``, and a pod created without them would boot into a
        project with nowhere to write and no key to write with.
        """
        if self._live:
            return await self._execute_live(spec)
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

    # -- live execution ----------------------------------------------------------------

    def _client(self) -> Any:
        """A Cloud Run client pointed at the USER's project, on a borrowed token.

        Deliberately the same ``GcpRunClient`` the managed tier uses, constructed with a
        different project and a different credential. Two clients would drift, and the
        whole value of the managed tier is that behaviour observed there transfers.
        """
        from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415
        from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token  # noqa: PLC0415

        if not self._bootstrap_sa:
            raise RuntimeError(
                "BYOC provisioning needs HUSSH_USER_GCP_BOOTSTRAP_SA — the account the "
                "user authorized hushh to impersonate. It is never inferred."
            )
        token = mint_bootstrap_token(bootstrap_sa=self._bootstrap_sa)
        return GcpRunClient(
            project=self._user_project, region=self._user_region, credentials=_StaticToken(token)
        )

    _ACTAS_BACKOFF_SECONDS: tuple[float, ...] = (5.0, 10.0, 20.0, 30.0)

    async def _execute_live(self, spec: PodSpec) -> BackendHandle:
        import asyncio  # noqa: PLC0415

        name = _service_name(spec.hushh_id)
        config = self.render_deploy_config(spec)
        client = await asyncio.to_thread(self._client)

        existing = await asyncio.to_thread(client.get_service, name)
        if existing is None:
            await _create_once_iam_settles(
                lambda: asyncio.to_thread(client.create_service, config)
            )
        else:
            await asyncio.to_thread(
                client.replace_service, name, client.merge_for_replace(existing, config)
            )

        ready = await asyncio.to_thread(client.wait_ready, name)
        # The hushh gateway is invited onto this ONE service. Without it the pod exists
        # and is reachable by nobody, which reads as a provisioning success and behaves
        # as a dead agent -- the same failure the managed tier hit and logged for.
        if self._hushh_invoker_sa:
            await asyncio.to_thread(
                client.set_invoker_binding, name, f"serviceAccount:{self._hushh_invoker_sa}"
            )
        else:
            logger.warning(
                "user_gcp_backend.no_invoker_member service=%s -- HUSSH_CONSENT_PLANE_SA is "
                "unset, so the hub cannot reach this pod and key collection will fail",
                name,
            )

        url = client.service_url(ready)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="live" if ready else "deploying",
            backend=self.backend_id,
            backend_metadata={
                "tenancy": "user-owned",
                "project": self._user_project,
                "region": spec.region or self._user_region,
                "service": name,
                "url": url or "",
                "ingress": "internal",
                "image": self._image,
                "keyless": True,
                "credential": "impersonated bootstrap SA, 15-minute token",
            },
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            import asyncio  # noqa: PLC0415

            client = await asyncio.to_thread(self._client)
            await asyncio.to_thread(client.delete_service, external_agent_id)
            logger.info("user_gcp_backend.deprovisioned service=%s", external_agent_id)
            return None
        logger.info("user_gcp_backend.plan_deprovision service=%s", external_agent_id)
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self._live:
            import asyncio  # noqa: PLC0415

            client = await asyncio.to_thread(self._client)
            svc = await asyncio.to_thread(client.get_service, external_agent_id)
            if svc is None:
                return BackendStatus(
                    external_agent_id=(external_agent_id or None), status="missing", healthy=False
                )
            conditions = {
                c.get("type"): c.get("status") for c in svc.get("status", {}).get("conditions", [])
            }
            ready = conditions.get("Ready") == "True"
            return BackendStatus(
                external_agent_id=(external_agent_id or None),
                status="live" if ready else "deploying",
                healthy=ready,
            )
        return BackendStatus(
            external_agent_id=(external_agent_id or None), status="planned", healthy=True
        )

    async def health(self) -> bool:
        return True


__all__ = ["UserGcpBackend"]
