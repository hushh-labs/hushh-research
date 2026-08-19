"""Minimal Cloud Run Admin (v1 knative) REST client for the GCP compute backend.

Used ONLY in live mode by ``GcpBackend`` to actually create / get / delete a
per-user Cloud Run service. The token is minted from the operator service account
(``GCP_DEPLOY_SA_KEY_B64``); every call goes through the agent proxy + CA bundle
the environment configures (honored automatically by requests via the proxy env).

Sync + requests-based (google-auth's transport is requests); ``GcpBackend`` calls
it off the event loop via ``asyncio.to_thread``. The v1 knative API is used because
its Service body is exactly what ``GcpBackend.render_deploy_config`` already emits.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_SA_KEY_ENV = "GCP_DEPLOY_SA_KEY_B64"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_INVOKER_ROLE = "roles/run.invoker"


def load_operator_credentials(sa_key_b64: Optional[str] = None) -> Any:
    """Credentials for the Cloud Run Admin API: an explicit key, else the ATTACHED identity.

    Prefer the attached identity, and understand why before reaching for a key.

    **The hub holds no key, and it should not.** Reading the live dev service
    confirmed ``GCP_DEPLOY_SA_KEY_B64`` is absent from its 60 environment entries,
    so this function used to raise and ``GcpBackend`` live mode could not create a
    pod at all. The obvious repair -- mount the operator key -- is the wrong one:
    that key is ORG ADMIN, and putting org-admin credentials in a shared,
    internet-reachable, multi-tenant service means one RCE or SSRF yields org-wide
    GCP control. It is also the kind of finding a FedRAMP assessor opens with.

    **The hub already has the permission it needs.** It runs as
    ``consent-protocol-runtime@…``, which holds ``roles/run.admin`` -- verified
    against the live IAM policy. Application Default Credentials pick that identity
    up from the metadata server with no key material anywhere: nothing to leak,
    nothing to rotate, nothing to accidentally commit. That is the standard GCP
    posture and the one this deployment was already provisioned for.

    An explicit key still wins when supplied, because operator tooling and CI run
    outside GCP where there is no attached identity to fall back to. Both paths ask
    for the same scopes, so a caller cannot tell them apart except by which one is
    available -- and the failure message names both, since "no credentials" with no
    hint of where they should come from is how this stayed broken.
    """
    raw = sa_key_b64 if sa_key_b64 is not None else os.getenv(_SA_KEY_ENV, "")
    if raw:
        from google.oauth2 import service_account  # noqa: PLC0415

        info = json.loads(base64.b64decode(raw))
        return service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)

    try:
        import google.auth  # noqa: PLC0415

        credentials, _ = google.auth.default(scopes=_SCOPES)
    except Exception as exc:  # noqa: BLE001 - report both paths, never just one
        raise RuntimeError(
            f"no Cloud Run credentials: {_SA_KEY_ENV} is unset and no attached "
            f"service account is available ({type(exc).__name__}). In GCP the hub "
            "should use its own runtime identity; outside GCP supply the key."
        ) from exc
    logger.info("gcp_run.credentials source=attached_service_account")
    return credentials


def resolve_admin_project(sa_key_b64: Optional[str] = None) -> Optional[str]:
    """The project whose Cloud Run we can actually administer.

    Not the same question as "what project is this process configured for", and
    conflating the two is what kept the pod fleet empty. ``GOOGLE_CLOUD_PROJECT``
    is set to the *Vertex* project on the dev lane -- deliberately, because dev
    borrows UAT's Vertex for model access -- so a backend that reads it to decide
    where to create pods aims every provision at a project its identity holds no
    ``run.admin`` in, and every create 403s at the caller before the pod service
    account is ever considered.

    The honest source is whatever the CREDENTIALS say. For an attached identity
    ``google.auth.default()`` already returns the project alongside them (the
    second element, historically discarded here); for an explicit operator key it
    is the key's own ``project_id``. Either way the answer is "the project this
    caller can act in", which is exactly the question being asked.

    Returns ``None`` off-GCP with no key, so callers fail loudly rather than
    guessing.
    """
    raw = sa_key_b64 if sa_key_b64 is not None else os.getenv(_SA_KEY_ENV, "")
    if raw:
        try:
            info = json.loads(base64.b64decode(raw))
        except Exception:  # noqa: BLE001 - a malformed key is not a project answer
            return None
        project = str(info.get("project_id") or "").strip()
        return project or None

    try:
        import google.auth  # noqa: PLC0415

        _credentials, project = google.auth.default(scopes=_SCOPES)
    except Exception:  # noqa: BLE001 - absence is a real answer here
        return None
    project = str(project or "").strip()
    return project or None


class GcpRunClient:
    """Create / get / delete Cloud Run services via the v1 knative regional API."""

    def __init__(self, *, project: str, region: str, credentials: Any = None) -> None:
        if not project:
            raise RuntimeError("GcpRunClient requires a project")
        self._project = project
        self._region = region
        self._creds = credentials if credentials is not None else load_operator_credentials()
        self._base = (
            f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project}"
        )

    def _headers(self) -> dict[str, str]:
        import google.auth.transport.requests as gtr

        if not getattr(self._creds, "valid", False):
            self._creds.refresh(gtr.Request())
        return {
            "Authorization": f"Bearer {self._creds.token}",
            "Content-Type": "application/json",
        }

    def create_service(self, body: dict[str, Any]) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        r = requests.post(f"{self._base}/services", headers=self._headers(), json=body, timeout=60)
        if r.status_code == 409:
            # AlreadyExists: a prior create for this DETERMINISTIC name already made
            # the service (a retry of a stuck 'provisioning' row hits the same
            # one-pod-{slug(hushh_id)} name). Adopt the existing service instead of
            # raising 409 forever -- the create is convergent, so a registry row and
            # its host can never permanently disagree. That permanent-409 retry loop
            # is otherwise the single most likely way a pod orphans.
            name = str(((body.get("metadata") or {}).get("name")) or "")
            if name:
                existing = self.get_service(name)
                if existing is not None:
                    return existing
        r.raise_for_status()
        return dict(r.json())

    # -- IAM ---------------------------------------------------------------------
    #
    # A pod is created with ``internal`` ingress and NO ``allUsers`` binding, so
    # nothing can reach it until something is explicitly allowed to. Two modules
    # already depend on that something existing -- ``pod_relay`` ("the pod SA grants
    # run.invoker to the hub runtime") and ``pod_key_collector`` -- and until now it
    # existed in a runbook and nowhere else. The consequence was silent and total: a
    # freshly created pod was invokable by nobody, so the hub's key pull returned
    # None, the registry row parked in ``connecting`` forever, and the standing
    # pkm.read was never minted. Provisioning never completed and never said why.
    #
    # IAM lives on the Cloud Run ADMIN v1 surface, not the knative one, so it needs
    # its own base URL -- ``self._base`` points at
    # ``/apis/serving.knative.dev/v1/namespaces/{project}`` and there is no IAM verb
    # under it.

    def _iam_url(self, name: str, verb: str) -> str:
        return (
            f"https://{self._region}-run.googleapis.com/v1/projects/{self._project}"
            f"/locations/{self._region}/services/{name}:{verb}"
        )

    def get_iam_policy(self, name: str) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        r = requests.get(self._iam_url(name, "getIamPolicy"), headers=self._headers(), timeout=30)
        r.raise_for_status()
        return dict(r.json())

    def set_invoker_binding(self, name: str, member: str) -> dict[str, Any]:
        """Allow exactly ``member`` to invoke this pod. Read-modify-write, never blind.

        **Read-modify-write, not overwrite.** ``setIamPolicy`` replaces the whole
        policy, so posting a freshly-built one-binding document would silently drop
        every other binding on the service -- including any an operator added by
        hand during an incident. This reads the live policy, adds the member to the
        existing ``roles/run.invoker`` binding if there is one, and writes the result
        back carrying ``etag`` so a concurrent change rejects the call instead of
        being clobbered.

        **Never ``allUsers`` / ``allAuthenticatedUsers``.** The pod's whole security
        property is that it is not targetable; a public invoker binding would undo
        it more completely than widening ingress does, because ingress controls
        *where* a caller may come from and IAM controls *who* they must be. Refused
        here rather than trusted to the caller, since this is the one function in
        the codebase that could make a person's private agent world-reachable.
        """
        import requests  # type: ignore[import-untyped]

        principal = str(member or "").strip()
        if not principal:
            raise RuntimeError("set_invoker_binding requires a member")
        if principal in ("allUsers", "allAuthenticatedUsers"):
            raise RuntimeError(
                f"refusing to grant run.invoker to {principal}: a pod must never be "
                "publicly invokable"
            )

        policy = self.get_iam_policy(name)
        bindings = [dict(b) for b in (policy.get("bindings") or [])]
        for binding in bindings:
            if binding.get("role") == _INVOKER_ROLE:
                members = list(binding.get("members") or [])
                if principal in members:
                    # Already granted. Returning without a write keeps provisioning
                    # idempotent -- a re-provision or a heal must not churn the policy.
                    logger.info("gcp_run.invoker_already_bound service=%s", name)
                    return policy
                members.append(principal)
                binding["members"] = members
                break
        else:
            bindings.append({"role": _INVOKER_ROLE, "members": [principal]})

        body: dict[str, Any] = {"policy": {"bindings": bindings}}
        # Carry the etag so this is an optimistic-concurrency update. Without it a
        # racing writer's change would be overwritten with no error.
        if policy.get("etag"):
            body["policy"]["etag"] = policy["etag"]

        r = requests.post(
            self._iam_url(name, "setIamPolicy"), headers=self._headers(), json=body, timeout=30
        )
        r.raise_for_status()
        logger.info("gcp_run.invoker_bound service=%s", name)
        return dict(r.json())

    @staticmethod
    def merge_for_replace(
        current: dict[str, Any],
        desired: dict[str, Any],
        *,
        revision_nonce: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build the PUT body for an in-place replace. Pure -- no I/O, so it is tested.

        Three things have to be true at once and none of them are automatic:

        1. **System-managed metadata survives.** The live object carries fields the
           caller's rendered config has never heard of (``uid``, ``creationTimestamp``,
           ``serving.knative.dev/creator``, operation ids). ``replaceService`` only
           permits ``spec`` plus metadata labels/annotations to change, so the body is
           built by overlaying the desired spec onto the LIVE object rather than
           posting the rendered config as if it were whole.

        2. **``resourceVersion`` is carried forward.** That is what makes the PUT an
           optimistic-concurrency update: if anything else wrote to the service since
           the read, the API rejects this instead of silently clobbering it.

        3. **The revision template genuinely differs.** Cloud Run mints a new revision
           only when the template changes. A heal that replays the identical template
           is accepted, changes nothing, and restarts NOTHING -- the container keeps
           running with whatever broke it, while the caller logs a successful heal.
           ``revision_nonce`` stamps the template so the new revision is real, and it
           doubles as a durable record of when this pod was last healed.
        """
        merged = dict(current)
        merged["spec"] = desired.get("spec") or {}

        current_meta = dict(current.get("metadata") or {})
        desired_meta = dict(desired.get("metadata") or {})
        # Labels and annotations are the only metadata the API lets us modify; take
        # the desired values but keep any the live object has that we do not render,
        # so a replace never strips a field someone else set.
        for key in ("labels", "annotations"):
            if desired_meta.get(key):
                current_meta[key] = {**(current_meta.get(key) or {}), **desired_meta[key]}
        merged["metadata"] = current_meta

        if revision_nonce:
            template = dict(merged["spec"].get("template") or {})
            template_meta = dict(template.get("metadata") or {})
            template_meta["annotations"] = {
                **(template_meta.get("annotations") or {}),
                "hussh/restart-nonce": revision_nonce,
            }
            template["metadata"] = template_meta
            merged["spec"] = {**merged["spec"], "template": template}

        # `status` is server-owned; sending a stale copy back is at best ignored and
        # at worst rejected.
        merged.pop("status", None)
        return merged

    def replace_service(
        self,
        name: str,
        body: dict[str, Any],
        *,
        revision_nonce: Optional[str] = None,
    ) -> dict[str, Any]:
        """Replace a live service in place (PUT), rolling it onto a fresh revision.

        This is the RESTART primitive, and it is deliberately not ``delete`` +
        ``create``. Deleting a Cloud Run service drops its URL, and the hub has that
        URL recorded; a restart that changes the address is not a restart, it is a
        migration the owner never asked for. A PUT keeps the service, its name, and
        its URL, and swaps only the revision underneath.

        Raises if the service does not exist. A replace is not a create -- conflating
        the two is how "restart my agent" quietly becomes "provision a new one",
        which is a different act with different consequences for the caller.
        """
        import requests  # type: ignore[import-untyped]

        current = self.get_service(name)
        if current is None:
            raise RuntimeError(f"cannot replace {name}: no such Cloud Run service")

        merged = self.merge_for_replace(current, body, revision_nonce=revision_nonce)
        r = requests.put(
            f"{self._base}/services/{name}", headers=self._headers(), json=merged, timeout=60
        )
        r.raise_for_status()
        logger.info("gcp_run.replaced name=%s nonce_present=%s", name, bool(revision_nonce))
        return dict(r.json())

    def get_service(self, name: str) -> Optional[dict[str, Any]]:
        import requests  # type: ignore[import-untyped]

        r = requests.get(f"{self._base}/services/{name}", headers=self._headers(), timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return dict(r.json())

    def delete_service(self, name: str) -> None:
        import requests  # type: ignore[import-untyped]

        r = requests.delete(f"{self._base}/services/{name}", headers=self._headers(), timeout=60)
        # Idempotent teardown: an already-gone service is success.
        if r.status_code not in (200, 404):
            r.raise_for_status()

    def wait_ready(
        self, name: str, *, timeout_s: float = 150.0, interval_s: float = 3.0
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        """Poll until the service's Ready condition is True (ok) or False (failed),
        or the timeout elapses. Returns (ready, last_service_json)."""
        deadline = time.monotonic() + timeout_s
        last: Optional[dict[str, Any]] = None
        while time.monotonic() < deadline:
            svc = self.get_service(name)
            last = svc
            conditions = ((svc or {}).get("status") or {}).get("conditions") or []
            ready = next((c for c in conditions if c.get("type") == "Ready"), None)
            if ready and ready.get("status") == "True":
                return True, svc
            if ready and ready.get("status") == "False":
                logger.warning("gcp_run.not_ready name=%s reason=%s", name, ready.get("message"))
                return False, svc
            time.sleep(interval_s)
        return False, last

    @staticmethod
    def service_url(svc: Optional[dict[str, Any]]) -> Optional[str]:
        return ((svc or {}).get("status") or {}).get("url")
