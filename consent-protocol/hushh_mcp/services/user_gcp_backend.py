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

import base64
import hashlib
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


#: Google's hard limit on a service-account `accountId`. Not a style preference:
#: `CreateServiceAccountRequest.accountId` is documented as "6-30 characters" and the
#: IAM API answers 400 outside that range.
_SA_ID_MAX = 30
_SA_PREFIX = "one-pod-"
#: Base32 of a SHA-256, lowercased. 8 chars = 40 bits, on top of the ~45 bits the
#: retained slug prefix still carries, so two people colliding needs both halves to
#: match. Base32 rather than hex because the alphabet is denser per character and
#: every symbol is already legal in an accountId.
_SA_DIGEST_CHARS = 8


def _bare_service_account(value: Optional[str]) -> str:
    """Strip a `serviceAccount:` prefix if the operator supplied one.

    Two variables name the same principal in two different shapes, which is a trap
    with no natural warning. The managed tier reads `HUSSH_POD_INVOKER_MEMBER`, whose
    value is already IAM-member form (`scripts/deploy/backend-deploy.sh` emits
    `serviceAccount:consent-protocol-runtime@...`). BYOC reads `HUSSH_CONSENT_PLANE_SA`
    and prepends the prefix itself at bind time.

    So the obvious operator action -- copy the value that is already sitting in the
    other variable -- produces `serviceAccount:serviceAccount:...`, which IAM rejects
    with a 400 on every `setIamPolicy`, at the key handshake, after the pod is already
    built. Normalising here costs one line and removes the whole class; refusing the
    prefixed form instead would be correct and would still waste somebody's afternoon.
    """
    text = str(value or "").strip()
    return text[len("serviceAccount:") :].strip() if text.startswith("serviceAccount:") else text


def pod_service_account_id(hushh_id: str) -> str:
    """The pod's runtime identity, guaranteed to fit Google's 6-30 character limit.

    THE DEFECT THIS EXISTS TO CLOSE

    A real HusshID is ``"ha1_"`` + base32(20 bytes) = **36 characters**, `_slug` caps
    at 40 so nothing is trimmed, and ``"one-pod-" + slug`` is therefore **44** — over
    the limit by 14 for **every real person**. The `pod_service_account` bootstrap step
    could only ever return 400, and the Cloud Run body would name a service account
    that cannot exist.

    It survived because every test and the single live BYOC run used a short synthetic
    id: ``HA1BYOC0000001`` (22), ``HA1ABC234DEF`` (20), ``ha1byocjourney01`` (24). Each
    fits, so the whole suite was green against a limit no real id can satisfy. That is
    the shape of §2e in `verify-before-claim` -- a guard that never fired -- with the
    twist that the *fixture* was what kept it quiet.

    WHY IT TRUNCATES-AND-HASHES RATHER THAN JUST TRUNCATING

    The name must stay a deterministic function of the HusshID: re-provision, teardown
    and the drift read all recompute it rather than looking it up, so two people must
    never derive the same account. A bare truncation to 22 characters keeps only the
    first ~9 characters of entropy after the constant ``ha1-`` prefix; appending a
    digest of the WHOLE id restores the rest.

    Ids that already fit are returned byte-identical, so nothing that exists today is
    renamed -- only names that were invalid anyway change.
    """
    slug = _slug(hushh_id)
    candidate = f"{_SA_PREFIX}{slug}"
    if len(candidate) <= _SA_ID_MAX:
        return candidate

    digest = (
        base64.b32encode(hashlib.sha256(str(hushh_id or "").encode("utf-8")).digest())
        .decode("ascii")
        .lower()[:_SA_DIGEST_CHARS]
    )
    keep = _SA_ID_MAX - len(_SA_PREFIX) - 1 - _SA_DIGEST_CHARS
    head = slug[:keep].strip("-")
    # A pathological id whose head strips to nothing would otherwise render a double
    # hyphen, which IAM also rejects.
    return f"{_SA_PREFIX}{head}-{digest}" if head else f"{_SA_PREFIX}{digest}"


def _pod_vertex_location(fallback_region: str) -> str:
    """Where a BYOC pod should address Vertex, taken from the MODEL's own contract.

    The pod's Cloud Run region and its Vertex endpoint are unrelated facts that happened
    to share a variable. `registry.py` already declares which locations each model is
    served at -- the default model is ``("global",)`` -- and `locations_for_model` is the
    managed tier's use of that same declaration. The BYOC renderer had no equivalent, so
    it substituted the one region it had at hand.

    Falls back to the pod's region rather than raising: a model that declares no
    supported locations is making no claim, and refusing to render a pod over a missing
    registry annotation would trade a wrong endpoint for no agent at all.
    """
    from hushh_mcp.constants import GEMINI_MODEL  # noqa: PLC0415
    from hushh_mcp.runtime_providers.registry import resolve_model_entry  # noqa: PLC0415

    try:
        supported = resolve_model_entry("gemini", GEMINI_MODEL).supported_vertex_locations
    except Exception:  # noqa: BLE001 - an unknown model is not a reason to refuse a pod
        logger.warning("user_gcp.vertex_location_unresolved model=%s", GEMINI_MODEL)
        return fallback_region
    return supported[0] if supported else fallback_region


#: Env the MANAGED tier ships that a BYOC pod must never receive. Two are plaintext
#: keys derived from hushh's master; the third points at hushh's own bucket. Listed by
#: name rather than filtered by pattern, so adding a managed-only variable later is a
#: decision someone makes here instead of an omission nobody notices.
_MANAGED_ONLY_ENV = frozenset(
    {
        "HUSSH_POD_LOG_KEY",
        "HUSSH_POD_MEMORY_KEY",
        # Mounted by reference from HUSHH's Secret Manager. Cloud Run resolves a
        # secretKeyRef against the project the service runs in, so the managed name
        # cannot resolve in a user's project -- and should not: this key signs the
        # person's own consent tokens and receipts, so it is theirs.
        "APP_SIGNING_KEY",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_BACKEND",
        "POD_AGENT_MEMORY_ENABLED",
        # The Vertex address. The managed renderer resolves these as
        # `HUSSH_POD_VERTEX_PROJECT or self._project` (gcp_backend.py:372), so the
        # HUB's env wins -- and a user-owned pod would then run as the USER's service
        # account while pointing GOOGLE_CLOUD_PROJECT at HUSHH's project. That is a
        # cross-tenant address, and it is exactly backwards for the tier whose entire
        # purpose is that the person's compute is their own.
        #
        # Latent rather than live today only because HUSSH_POD_VERTEX_PROJECT is unset
        # on the dev hub (verified 2026-08-12) -- so the fallback happens to be right.
        # The moment the managed tier sets it, every BYOC pod silently re-points. These
        # are stripped here and re-added below against the USER's project.
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
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
        bootstrap_sa: Optional[str] = None,
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
        self._hushh_invoker_sa = _bare_service_account(
            hushh_invoker_sa if hushh_invoker_sa is not None else _env("HUSSH_CONSENT_PLANE_SA")
        )
        self._live = bool(live) if live is not None else _flag("HUSSH_USER_GCP_LIVE")
        # The account in the USER's project that hushh was authorized to impersonate.
        # Never derived from the project name: a guessed identity that happens to exist
        # would be used silently, and the point of the grant is that it was made.
        # Per person when the caller knows who this pod belongs to, env only as the
        # single-tenant dev fallback. One person's bootstrap account is
        # `one-bootstrap@their-project` and another's is `one-bootstrap@other-project`,
        # so this stopped being one environment variable the moment there were two
        # people.
        self._bootstrap_sa = (
            bootstrap_sa if bootstrap_sa is not None else _env("HUSSH_USER_GCP_BOOTSTRAP_SA")
        )
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
            f"{pod_service_account_id(spec.hushh_id)}@{project}.iam.gserviceaccount.com"
        )

        kept = [e for e in container.get("env", []) if e["name"] not in _MANAGED_ONLY_ENV]
        kept.extend(
            [
                {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
                # The user's own CMEK bucket, created by their own bootstrap.
                {"name": "POD_STORAGE_GCS_BUCKET", "value": f"one-pod-{slug}-blobs"},
                {"name": "POD_STORAGE_GCS_PREFIX", "value": f"pods/{spec.hushh_id}"},
                {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
                # Vertex resolves against the USER's project, always. This pod runs as
                # the user's own service account in the user's own project, so its
                # native ADC is theirs -- which is precisely why a BYO GCP person does
                # not need to hand hushh a separate model key. Re-added here rather
                # than inherited so the hub's Vertex address can never reach a pod it
                # does not own.
                {"name": "GOOGLE_CLOUD_PROJECT", "value": project},
                # A Vertex location is a property of the MODEL, not of where the pod
                # happens to run. This used to render `region`, the pod's Cloud Run
                # region, so every BYOC pod addressed Vertex at us-central1 while the
                # default model is declared `global`-only -- a 404 on the first turn,
                # surfacing as the same opaque error every other turn failure produces.
                # The hub gets this right for itself (`GOOGLE_CLOUD_LOCATION=global`);
                # nothing carried that fact into a pod.
                {"name": "GOOGLE_CLOUD_LOCATION", "value": _pod_vertex_location(region)},
                # The NAME for what the two lines above already make true. Without it
                # `_resolve_runtime_mode` has no branch for "serve on my own ADC" and a
                # credential-less turn 400s -- so a BYOC pod, whose model access is
                # complete, refused every turn for want of a vocabulary entry.
                #
                # Rendered ONLY here, never by `GcpBackend`, and never propagated from
                # the hub's own environment the way `HUSSH_POD_TURN_ENABLED` is. This is
                # a fact about ONE person's pod: it is true because this renderer is
                # building into that person's project, and it would be false anywhere
                # hushh owns the ambient identity.
                {"name": "HUSSH_POD_USER_ADC_ENABLED", "value": "true"},
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
        # The pod's own signing key, from the person's own Secret Manager, created by
        # their own bootstrap. Mounted by reference: the value never enters the artifact.
        kept.append(
            {
                "name": "APP_SIGNING_KEY",
                "valueFrom": {
                    # Named from `pod_service_account_id`, NOT the raw slug. The bootstrap
                    # creates, seeds and IAM-binds `{pod_service_account_id(hushh_id)}
                    # -signing-key`, which truncates and hashes to fit Google's 30-char
                    # service-account limit. The raw slug agrees with that only for SHORT
                    # ids -- exactly the synthetic ids every BYOC test uses -- so for every
                    # real 36-character HusshID this mounted a secret nothing ever creates.
                    # The revision then crash-loops on `APP_SIGNING_KEY must be set`, and
                    # Cloud Run reports an unresolvable secretKeyRef as a PERMISSION error
                    # naming the pod account, which sends an operator to a secretAccessor
                    # binding that is present and correct on the other name.
                    "secretKeyRef": {
                        "name": f"{pod_service_account_id(spec.hushh_id)}-signing-key",
                        "key": "latest",
                    }
                },
            }
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
        pod_sa = f"{pod_service_account_id(spec.hushh_id)}@{project}.iam.gserviceaccount.com"
        kms_key = f"one-pod-{slug}-key"
        bucket = f"one-pod-{slug}-blobs"
        invoker = self._hushh_invoker_sa or "<hushh-consent-plane-sa>"
        # Per-user mail-event trigger, entirely inside the user's project (BYOC): Gmail
        # push -> the user's OWN Pub/Sub topic; the always-on pod pulls its own wake
        # events. A metadata-only doorbell -- the pod opens the mail, never Hushh.
        # Created by `UserGcpBootstrap` step `pod_signing_secret` and, until now,
        # declared by the plan nowhere. A resource the plan does not name cannot appear
        # in `resource_ids(plan)`, so the teardown receipt could never account for it.
        signing_secret = f"{pod_service_account_id(spec.hushh_id)}-signing-key"
        # The account the PERSON creates when they run deploy/iam/authorize_byoc_project.sh,
        # whose BOOTSTRAP_SA_ID defaults to `one-bootstrap`. This used to render
        # `one-bootstrap-{slug}@`, which no script anywhere creates -- so the artifact a
        # person reads named an identity that would never exist.
        bootstrap_sa = self._bootstrap_sa or f"one-bootstrap@{project}.iam.gserviceaccount.com"
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
                    "type": "secret",
                    "id": signing_secret,
                    "purpose": "the pod signs its own receipts with this; hushh never reads it",
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
            # THE CONSENT ARTIFACT. This list is what a person is shown before they
            # authorize their project, so it must name every grant the applier actually
            # makes. It did not: five roles were bound by `UserGcpBootstrap.plan_calls`
            # and advertised nowhere -- including the ONLY project-level grant in the
            # design. Asking someone to consent to a list that omits the broadest thing
            # on it is the failure `test_byoc_authorization_script_matches_the_applier`
            # exists to prevent, applied to the pair that actually diverged.
            "iam": [
                {"member": pod_sa, "role": "roles/cloudkms.cryptoKeyDecrypter", "on": kms_key},
                {
                    "member": pod_sa,
                    "role": "roles/cloudkms.cryptoKeyEncrypter",
                    "on": kms_key,
                    "note": "the pod generates and WRAPS its own data key on first boot; hushh never holds the plaintext",
                },
                {
                    "member": "the project's Cloud Storage service agent",
                    "role": "roles/cloudkms.cryptoKeyEncrypterDecrypter",
                    "on": kms_key,
                    "note": "what makes the bucket CMEK-encrypted under YOUR key rather than Google's default",
                },
                {"member": pod_sa, "role": "roles/storage.objectAdmin", "on": bucket},
                {
                    "member": pod_sa,
                    "role": "roles/secretmanager.secretAccessor",
                    "on": signing_secret,
                    "note": "the pod reads its own signing secret; scoped to that one secret",
                },
                {
                    "member": bootstrap_sa,
                    "role": "roles/iam.serviceAccountUser",
                    "on": pod_sa,
                    "note": "lets the bootstrap deploy a service that RUNS AS the pod account, and nothing else",
                },
                {
                    "member": pod_sa,
                    "role": "roles/aiplatform.user",
                    "on": f"project:{project}",
                    "project_level": True,
                    "note": (
                        "PROJECT-LEVEL, and the only project-wide grant here. Vertex has "
                        "no per-resource binding to scope to. This is your agent calling "
                        "Vertex as itself, on your own quota and your own bill -- which "
                        "is what lets it work without you handing hushh an AI key"
                    ),
                },
                {
                    "member": invoker,
                    "role": "roles/run.invoker",
                    "on": name,
                    "applied_at": "provision",
                    "note": (
                        "lets ONLY the Hushh A2A gateway reach the pod; Hushh holds no key "
                        "into this project. Bound when the service is created, not during "
                        "bootstrap, because the binding needs a service to bind to"
                    ),
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
                "type": "impersonation"
                if self._hushh_invoker_sa
                else "workload_identity_federation",
                "impersonation": {
                    "bootstrap_service_account": bootstrap_sa,
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
            await _create_once_iam_settles(lambda: asyncio.to_thread(client.create_service, config))
        else:
            await asyncio.to_thread(
                client.replace_service, name, client.merge_for_replace(existing, config)
            )
        # Same narrative stages as the managed tier, same names -- the vocabulary is
        # shared with trace_pod_journey so the operator diagnostic and the person's
        # progress bar tell one story. This path is async (no _run closure), so the
        # emits sit beside the awaits they describe. emit_stage swallows everything.
        spec.emit_stage("host_created")

        # `wait_ready` returns (ready, service_json). Binding it to one name left `ready`
        # holding the TUPLE -- which is truthy whatever it contains, so a pod that failed
        # its startup probe was reported `live`, and `service_url` was handed a tuple and
        # raised. The managed tier unpacks it correctly (`gcp_backend.py:566`); this path
        # did not, and only a pod that genuinely failed to boot could show the difference.
        ready, svc = await asyncio.to_thread(client.wait_ready, name)
        if ready:
            spec.emit_stage("host_serving")
        # The hushh gateway is invited onto this ONE service. Without it the pod exists
        # and is reachable by nobody, which reads as a provisioning success and behaves
        # as a dead agent -- the same failure the managed tier hit and logged for.
        if self._hushh_invoker_sa:
            await asyncio.to_thread(
                client.set_invoker_binding, name, f"serviceAccount:{self._hushh_invoker_sa}"
            )
            spec.emit_stage("invoker_bound")
        else:
            logger.warning(
                "user_gcp_backend.no_invoker_member service=%s -- HUSSH_CONSENT_PLANE_SA is "
                "unset, so the hub cannot reach this pod and key collection will fail",
                name,
            )

        url = client.service_url(svc)
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
                # WHICH service account this pod runs as, recorded because on BYOC it
                # is the only thing that can tell one person's pod from another's.
                #
                # On the managed tier every pod shares one account -- which is exactly
                # what lets that account hold no project roles -- so the hub's identity
                # check can only ever prove "a hussh pod is calling", never which. The
                # asserted HusshID header is therefore compared against nothing.
                #
                # A BYOC pod runs as an account in the OWNER's project, derived per
                # person. Recording it here is what lets `verify_pod_identity` bind the
                # asserted HusshID to a verified email instead of trusting the header
                # -- the first point in this system where that header becomes a control
                # rather than a consistency check.
                "runtime_service_account": self._pod_service_account(spec),
            },
        )

    def _pod_service_account(self, spec: PodSpec) -> str:
        """The account this person's pod runs as, in their own project.

        Derived, not stored: `render_bootstrap_plan` already builds the same string
        from the same two inputs, and two places computing an identity from the same
        rule is one place too many to keep in agreement. Kept next to the plan so a
        change to the naming rule cannot silently desynchronise the account the
        bootstrap creates from the account the hub will later trust.
        """
        return (
            f"{pod_service_account_id(spec.hushh_id)}@{self._user_project}.iam.gserviceaccount.com"
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

    async def discover(self, hushh_id: str) -> Optional[BackendHandle]:
        """Find an ORPHANED pod that already exists for this person, to ADOPT not rebuild.

        The case: a returning user whose registry row was lost (they uninstalled and came
        back, or the row was reaped) but whose pod is still running in THEIR project.
        Because the service name is deterministic (``one-pod-<slug>``), one cheap
        ``get_service`` answers "is there already a pod here for this identity?" without
        listing the fleet.

        Adopting preserves the identity and its memory; the alternative -- provisioning --
        would create a duplicate service the deterministic name then 409s on, and rebuild
        would mint a NEW identity and discard the memory. So this is the FIRST thing the
        reinit/repair path should try.

        It refuses to claim a service that is not OURS: the discovered service must carry
        ``hussh-tenancy=user-owned``. Anything else in the project with a colliding name is
        left untouched -- we never adopt, and certainly never later tear down, a resource
        we did not create. Returns None when nothing adoptable exists (or in plan mode).
        """
        if not self._live:
            return None
        import asyncio  # noqa: PLC0415

        name = _service_name(hushh_id)
        client = await asyncio.to_thread(self._client)
        svc = await asyncio.to_thread(client.get_service, name)
        if svc is None:
            return None
        labels = ((svc.get("metadata") or {}).get("labels")) or {}
        if labels.get("hussh-tenancy") != "user-owned":
            # A name collision on something we did not create. Not adoptable.
            logger.warning(
                "user_gcp_backend.discover_foreign service=%s tenancy=%s",
                name,
                labels.get("hussh-tenancy"),
            )
            return None
        conditions = {
            c.get("type"): c.get("status") for c in svc.get("status", {}).get("conditions", [])
        }
        ready = conditions.get("Ready") == "True"
        url = client.service_url(svc)
        logger.info("user_gcp_backend.discovered service=%s ready=%s", name, ready)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=f"{A2A_ADDRESS_BASE}/{hushh_id}",
            status="live" if ready else "deploying",
            backend=self.backend_id,
            backend_metadata={
                "tenancy": "user-owned",
                "project": self._user_project,
                "region": self._user_region,
                "service": name,
                "url": url or "",
                "ingress": "internal",
                "adopted": True,
            },
        )

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self._live:
            import asyncio  # noqa: PLC0415

            client = await asyncio.to_thread(self._client)
            svc = await asyncio.to_thread(client.get_service, external_agent_id)
            if svc is None:
                # "gone", NOT "missing": the managed GcpBackend reports "gone"
                # for an absent service (gcp_backend.py), and pod_wake._host_is_gone
                # only recognizes "gone". Reporting "missing" here left the whole
                # missing-project -> reinit path silently dead for BYOC pods --
                # the exact sovereignty tier it targets (integration defect,
                # 2026-08-21). One word, one contract, both tiers.
                return BackendStatus(
                    external_agent_id=(external_agent_id or None), status="gone", healthy=False
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
