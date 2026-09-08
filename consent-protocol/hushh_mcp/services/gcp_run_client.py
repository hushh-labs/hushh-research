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
import math
import os
import re
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_SA_KEY_ENV = "GCP_DEPLOY_SA_KEY_B64"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_INVOKER_ROLE = "roles/run.invoker"
_MAX_SERVICE_LIST_PAGES = 1000


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

        _credentials, attached_project = google.auth.default(scopes=_SCOPES)
    except Exception:  # noqa: BLE001 - absence is a real answer here
        return None
    attached_project = str(attached_project or "").strip()
    return attached_project or None


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

    def create_service(
        self, body: dict[str, Any], *, adopt_existing: bool = True
    ) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        r = requests.post(
            f"{self._base}/services",
            headers=self._headers(),
            json=body,
            timeout=60,
            **({"allow_redirects": False} if not adopt_existing else {}),
        )
        if r.status_code == 409:
            if not adopt_existing:
                raise RuntimeError("Cloud Run service name is already owned")
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
        if not adopt_existing and r.status_code not in (200, 201):
            raise RuntimeError("Cloud Run exclusive creation not confirmed")
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
        expected_uid: Optional[str] = None,
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
        if expected_uid is not None:
            self.require_service_uid(current, expected_uid)
            version = (current.get("metadata") or {}).get("resourceVersion")
            if not isinstance(version, str) or not version.strip():
                raise RuntimeError("Cloud Run replacement concurrency version unavailable")

        merged = self.merge_for_replace(current, body, revision_nonce=revision_nonce)
        r = requests.put(
            f"{self._base}/services/{name}",
            headers=self._headers(),
            json=merged,
            timeout=60,
            allow_redirects=False,
        )
        r.raise_for_status()
        if r.status_code != 200:
            raise RuntimeError("Cloud Run replacement not confirmed")
        result = r.json()
        if not isinstance(result, dict):
            raise RuntimeError("Cloud Run replacement response invalid")
        if expected_uid is not None:
            self.require_service_uid(result, expected_uid)
        logger.info("gcp_run.replaced name=%s nonce_present=%s", name, bool(revision_nonce))
        return result

    @staticmethod
    def creation_runtime_evidence(
        service: dict[str, Any], *, requested_image: str
    ) -> dict[str, Any]:
        """Enrich the creation receipt only with observed, immutable runtime coordinates.

        Missing evidence must not discard the already acknowledged service UID.
        Such a receipt remains useful for recovery but cannot qualify fresh erasure.
        """
        metadata = service.get("metadata")
        spec = service.get("spec")
        if not isinstance(metadata, dict) or not isinstance(spec, dict):
            return {}
        template = spec.get("template")
        if not isinstance(template, dict) or not isinstance(template.get("spec"), dict):
            return {}
        generation = metadata.get("generation")
        containers = template["spec"].get("containers")
        if (
            type(generation) is not int
            or generation < 1
            or not isinstance(containers, list)
            or len(containers) != 1
            or not isinstance(containers[0], dict)
            or containers[0].get("image") != requested_image
            or not isinstance(requested_image, str)
            or re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", requested_image) is None
        ):
            return {}
        return {"initialGeneration": generation, "initialImage": requested_image}

    @staticmethod
    def erasure_fence_target(
        service: dict[str, Any], *, name: str, expected_uid: str
    ) -> dict[str, str]:
        """Observe a single serving revision for a fence, not deletion authority."""
        from urllib.parse import urlsplit

        GcpRunClient.require_service_uid(service, expected_uid)
        status = service.get("status") or {}
        revision = status.get("latestReadyRevisionName")
        url = GcpRunClient.service_url(service) or ""
        address = urlsplit(url)
        traffic = status.get("traffic") or []
        generation = (service.get("metadata") or {}).get("generation")
        observed = status.get("observedGeneration")
        if (
            type(generation) is not int
            or generation < 1
            or type(observed) is not int
            or observed != generation
            or (service.get("metadata") or {}).get("name") != name
            or not isinstance(revision, str)
            or not revision.startswith(name + "-")
            or status.get("latestCreatedRevisionName") != revision
            or len(traffic) != 1
            or traffic[0].get("revisionName") != revision
            or type(traffic[0].get("percent")) is not int
            or traffic[0]["percent"] != 100
            or address.scheme != "https"
            or not address.hostname
            or address.username
            or address.password
            or address.query
            or address.fragment
            or address.path not in ("", "/")
            or not any(
                c.get("type") == "Ready" and str(c.get("status")).lower() == "true"
                for c in status.get("conditions") or []
            )
        ):
            raise RuntimeError("erasure serving incarnation unavailable")
        return {
            "service": name,
            "serviceUid": expected_uid,
            "revision": revision,
            "podUrl": url.rstrip("/"),
        }

    def observe_erasure_runtime(self, *, name: str, expected_uid: str) -> dict[str, Any]:
        """Join the existing service fence observation to its resolved revision image."""
        import requests  # type: ignore[import-untyped]

        service = self.get_service(name)
        if service is None:
            raise RuntimeError("erasure runtime unavailable")
        target = self.erasure_fence_target(service, name=name, expected_uid=expected_uid)
        response = requests.get(
            f"{self._base}/revisions/{target['revision']}",
            headers=self._headers(),
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise RuntimeError("erasure revision unavailable")
        revision = response.json()
        metadata = revision.get("metadata") or {}
        digest = (revision.get("status") or {}).get("imageDigest")
        if (
            metadata.get("name") != target["revision"]
            or (metadata.get("labels") or {}).get("serving.knative.dev/service") != name
            or not isinstance(digest, str)
            or re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", digest) is None
        ):
            raise RuntimeError("erasure revision identity unavailable")
        # A replacement between reads is not a qualified observation.
        current = self.get_service(name)
        if (
            current is None
            or self.erasure_fence_target(current, name=name, expected_uid=expected_uid) != target
            or (current.get("metadata") or {}).get("generation")
            != service["metadata"]["generation"]
        ):
            raise RuntimeError("erasure runtime changed during observation")
        return {**target, "generation": service["metadata"]["generation"], "image": digest}

    @staticmethod
    def upgrade_acknowledgement(
        service: dict[str, Any], *, name: str, expected_uid: str, attempt_id: str
    ) -> dict[str, Any]:
        """Narrow receipt from the replacement response; never a readiness claim."""
        GcpRunClient.require_service_uid(service, expected_uid)
        metadata = service.get("metadata") or {}
        template = (service.get("spec") or {}).get("template") or {}
        nonce = ((template.get("metadata") or {}).get("annotations") or {}).get(
            "hussh/restart-nonce"
        )
        generation = metadata.get("generation")
        containers = (template.get("spec") or {}).get("containers") or []
        image = (
            containers[0].get("image") if containers and isinstance(containers[0], dict) else None
        )
        if (
            not attempt_id
            or nonce != attempt_id
            or metadata.get("name") != name
            or not isinstance(generation, int)
            or isinstance(generation, bool)
            or generation < 1
            or not isinstance(image, str)
            or not image.strip()
        ):
            raise RuntimeError("Cloud Run upgrade acknowledgement unverified")
        return {
            "version": 1,
            "service": name,
            "serviceUid": expected_uid,
            "generation": generation,
            "attemptId": attempt_id,
            "image": image,
        }

    def observe_upgrade_acknowledgement(
        self, receipt: dict[str, Any], *, name: str, expected_uid: str, attempt_id: str
    ) -> tuple[Optional[bool], dict[str, Any]]:
        """Observe the exact acknowledged replacement without submitting work."""
        if receipt.get("version") != 1 or receipt.get("service") != name:
            raise RuntimeError("Cloud Run upgrade receipt binding invalid")
        service = self.get_service(name)
        if service is None:
            raise RuntimeError("Cloud Run acknowledged service unavailable")
        actual = self.upgrade_acknowledgement(
            service, name=name, expected_uid=expected_uid, attempt_id=attempt_id
        )
        if any(receipt.get(key) != value for key, value in actual.items()):
            raise RuntimeError("Cloud Run acknowledged replacement changed")
        if not self._status_is_current(service):
            return None, service
        ready = next(
            (
                item
                for item in (service.get("status") or {}).get("conditions", [])
                if item.get("type") == "Ready"
            ),
            {},
        ).get("status")
        return ({"True": True, "False": False}.get(ready), service)

    @staticmethod
    def service_uid(service: Optional[dict[str, Any]]) -> str:
        metadata = service.get("metadata") if isinstance(service, dict) else None
        uid = metadata.get("uid") if isinstance(metadata, dict) else None
        if not isinstance(uid, str) or not uid.strip():
            raise RuntimeError("Cloud Run service incarnation unverified")
        return uid

    @staticmethod
    def require_service_uid(service: Optional[dict[str, Any]], expected_uid: str) -> None:
        if (
            not isinstance(expected_uid, str)
            or not expected_uid.strip()
            or GcpRunClient.service_uid(service) != expected_uid
        ):
            raise RuntimeError("Cloud Run service incarnation changed or unverified")

    def get_service(self, name: str) -> Optional[dict[str, Any]]:
        import requests  # type: ignore[import-untyped]

        r = requests.get(
            f"{self._base}/services/{name}",
            headers=self._headers(),
            timeout=30,
            allow_redirects=False,
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        if r.status_code != 200:
            raise RuntimeError("Cloud Run service observation not confirmed")
        return dict(r.json())

    def list_services(self, label_selector: str = "") -> list[dict[str, Any]]:
        """Every service in this project, optionally narrowed by a knative labelSelector.

        The discovery/reclaim substrate reads this to answer two questions the
        deterministic name alone cannot: "is there an orphaned pod for a person whose
        registry row we lost?" (Direction B of the orphan sweep) and "which pods carry
        our label?". A ``label_selector`` like ``app=hushh-one-pod,hussh-tenancy=user-owned``
        filters server-side, so a busy project does not stream us every service.

        A 403 is surfaced, never swallowed to an empty list: an empty list means "no
        such pods" and a 403 means "we could not look", and a reclaim sweep that
        confused the two would report a project swept-clean when it was merely
        unreadable. That is the R8 silent-fallback failure -- the caller decides what a
        permission error means, this method does not hide it.
        """
        import requests  # type: ignore[import-untyped]

        services: list[dict[str, Any]] = []
        continuation = ""
        seen_tokens: set[str] = set()
        for _ in range(_MAX_SERVICE_LIST_PAGES):
            params = {"labelSelector": label_selector} if label_selector else {}
            if continuation:
                params["continue"] = continuation
            r = requests.get(
                f"{self._base}/services",
                headers=self._headers(),
                params=params or None,
                timeout=30,
                allow_redirects=False,
            )
            r.raise_for_status()
            if r.status_code != 200:
                raise RuntimeError("Cloud Run service inventory status invalid")
            body = r.json()
            if not isinstance(body, dict) or "error" in body:
                raise RuntimeError("Cloud Run service inventory response invalid")
            items = body.get("items", [])
            metadata = body.get("metadata", {})
            if (
                not isinstance(items, list)
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("metadata"), dict)
                    or not isinstance(item["metadata"].get("name"), str)
                    or not item["metadata"]["name"].strip()
                    for item in items
                )
                or not isinstance(metadata, dict)
                or body.get("unreachable")
            ):
                raise RuntimeError("Cloud Run service inventory incomplete")
            continuation = metadata.get("continue", "")
            if not isinstance(continuation, str):
                raise RuntimeError("Cloud Run service inventory continuation invalid")
            services.extend(items)
            if not continuation:
                return services
            if continuation in seen_tokens:
                raise RuntimeError("Cloud Run service inventory continuation repeated")
            seen_tokens.add(continuation)
        # Never return a partial fleet: callers use absence for reconciliation.
        raise RuntimeError("Cloud Run service inventory page bound exceeded")

    def delete_service(
        self,
        name: str,
        *,
        expected_uid: Optional[str] = None,
        timeout_s: float = 60,
        interval_s: float = 1,
        operation_name: Optional[str] = None,
        before_submit: Optional[Callable[[dict[str, Any]], bool]] = None,
        on_acknowledged: Optional[Callable[[dict[str, Any]], bool]] = None,
    ) -> None:
        if (
            operation_name is not None or before_submit is not None or on_acknowledged is not None
        ) and expected_uid is None:
            raise ValueError("Durable deletion requires a service incarnation")
        if (before_submit is None) != (on_acknowledged is None):
            raise ValueError("Durable deletion requires both retention callbacks")
        if expected_uid is not None:
            self._delete_service_incarnation(
                name,
                expected_uid=expected_uid,
                timeout_s=timeout_s,
                interval_s=interval_s,
                operation_name=operation_name,
                before_submit=before_submit,
                on_acknowledged=on_acknowledged,
            )
            return
        import requests  # type: ignore[import-untyped]

        r = requests.delete(f"{self._base}/services/{name}", headers=self._headers(), timeout=60)
        # Idempotent teardown: an already-gone service is success.
        if r.status_code not in (200, 404):
            r.raise_for_status()

    def _delete_service_incarnation(
        self,
        name: str,
        *,
        expected_uid: str,
        timeout_s: float,
        interval_s: float,
        operation_name: Optional[str] = None,
        before_submit: Optional[Callable[[dict[str, Any]], bool]] = None,
        on_acknowledged: Optional[Callable[[dict[str, Any]], bool]] = None,
    ) -> None:
        """Delete only the recorded incarnation and verify absence before return.

        v2 exposes the etag deletion precondition. Matching UID before DELETE and
        sending that version's etag prevents a replacement between GET and DELETE
        from inheriting the deletion. Retention callbacks enable the existing
        lifecycle coordinator to record admission and acknowledgement. Supplying
        its persisted operation resumes polling without another DELETE. The
        coordinator owns attempt exclusivity and lost-acknowledgement recovery.
        """
        import requests  # type: ignore[import-untyped]

        if (
            not isinstance(name, str)
            or not name
            or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name)
            or not isinstance(expected_uid, str)
            or not expected_uid.strip()
            or isinstance(timeout_s, bool)
            or not isinstance(timeout_s, (float, int))
            or not math.isfinite(timeout_s)
            or isinstance(interval_s, bool)
            or not isinstance(interval_s, (float, int))
            or not math.isfinite(interval_s)
            or timeout_s <= 0
            or interval_s < 0
        ):
            raise ValueError("A valid service incarnation and deadline are required")
        url = (
            f"https://run.googleapis.com/v2/projects/{self._project}"
            f"/locations/{self._region}/services/{name}"
        )
        deadline = time.monotonic() + timeout_s

        def remaining() -> float:
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise RuntimeError("Cloud Run incarnation deletion remains incomplete")
            return min(30, budget)

        def observe() -> Optional[dict[str, Any]]:
            headers = self._headers()
            request_timeout = remaining()
            response = requests.get(
                url, headers=headers, timeout=request_timeout, allow_redirects=False
            )
            remaining()
            if response.status_code == 404:
                return None
            if response.status_code != 200:
                raise RuntimeError("Cloud Run incarnation observation unavailable")
            value = response.json()
            if not isinstance(value, dict) or value.get("uid") != expected_uid:
                raise RuntimeError("Cloud Run service incarnation changed")
            return value

        parent = f"projects/{self._project}/locations/{self._region}"
        service_name = f"{parent}/services/{name}"

        def validate_operation(value: Any) -> str:
            prefix = f"{parent}/operations/"
            if (
                not isinstance(value, str)
                or not value.startswith(prefix)
                or not re.fullmatch(r"[A-Za-z0-9_-]+", value[len(prefix) :])
            ):
                raise RuntimeError("Cloud Run deletion operation identity invalid")
            return value

        def finish_operation(operation: str) -> None:
            operation = validate_operation(operation)
            while True:
                headers = self._headers()
                request_timeout = remaining()
                result = requests.get(
                    f"https://run.googleapis.com/v2/{operation}",
                    headers=headers,
                    timeout=request_timeout,
                    allow_redirects=False,
                )
                remaining()
                if result.status_code != 200:
                    raise RuntimeError("Cloud Run deletion operation unavailable")
                body = result.json()
                if not isinstance(body, dict) or body.get("name") != operation:
                    raise RuntimeError("Cloud Run deletion operation identity invalid")
                if "error" in body:
                    raise RuntimeError("Cloud Run deletion operation failed")
                if body.get("done") is True:
                    deleted = body.get("response")
                    if (
                        not isinstance(deleted, dict)
                        or deleted.get("@type") != "type.googleapis.com/google.cloud.run.v2.Service"
                        or deleted.get("name") != service_name
                        or deleted.get("uid") != expected_uid
                        or not isinstance(deleted.get("deleteTime"), str)
                        or not deleted["deleteTime"].strip()
                    ):
                        raise RuntimeError("Cloud Run deletion completion identity invalid")
                    if observe() is not None:
                        raise RuntimeError("Cloud Run deletion absence unconfirmed")
                    return
                if body.get("done", False) is not False or "response" in body:
                    raise RuntimeError("Cloud Run deletion operation state invalid")
                time.sleep(min(interval_s, remaining()))

        # The registry must bind this acknowledgement to the owner/attempt before
        # supplying it here. Recovery polls only that operation; it never DELETEs.
        if operation_name is not None:
            finish_operation(operation_name)
            return

        before = observe()
        if before is None:
            if before_submit is not None:
                raise RuntimeError("Cloud Run deletion admission has no live incarnation")
            return
        etag = before.get("etag")
        if not isinstance(etag, str) or not etag.strip():
            raise RuntimeError("Cloud Run deletion precondition unavailable")
        admission: dict[str, Any] = {
            "serviceName": service_name,
            "serviceUid": expected_uid,
            "etag": etag,
        }
        if before_submit is not None:
            if before.get("name") != service_name:
                raise RuntimeError("Cloud Run deletion service identity invalid")
            template = before.get("template")
            containers = template.get("containers") if isinstance(template, dict) else None
            generation = before.get("generation")
            if (
                not isinstance(generation, str)
                or not re.fullmatch(r"[1-9][0-9]{0,18}", generation)
                or not isinstance(containers, list)
                or len(containers) != 1
                or not isinstance(containers[0], dict)
                or not isinstance(containers[0].get("image"), str)
            ):
                raise RuntimeError("Cloud Run deletion runtime evidence unavailable")
            admission.update(generation=int(generation), image=containers[0]["image"])
            if before_submit(dict(admission)) is not True:
                raise RuntimeError("Cloud Run deletion admission retention unconfirmed")
        headers = self._headers()
        request_timeout = remaining()
        response = requests.delete(
            url,
            headers=headers,
            params={"etag": etag},
            timeout=request_timeout,
            allow_redirects=False,
        )
        if response.status_code not in (200, 404):
            raise RuntimeError("Cloud Run incarnation deletion not accepted")
        if on_acknowledged is not None:
            if response.status_code != 200:
                raise RuntimeError("Cloud Run deletion acknowledgement unavailable")
            body = response.json()
            operation = validate_operation(body.get("name") if isinstance(body, dict) else None)
            if on_acknowledged({**admission, "operationName": operation}) is not True:
                raise RuntimeError("Cloud Run deletion acknowledgement retention unconfirmed")
            finish_operation(operation)
            return
        while True:
            if observe() is None:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Cloud Run incarnation deletion remains incomplete")
            time.sleep(min(interval_s, max(0, deadline - time.monotonic())))

    def wait_ready(
        self,
        name: str,
        *,
        timeout_s: float = 150.0,
        interval_s: float = 3.0,
        expected_uid: Optional[str] = None,
        expected_revision_nonce: Optional[str] = None,
        expected_generation: Optional[int] = None,
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        """Poll until the service's Ready condition is True (ok) or False (failed),
        or the timeout elapses. Returns (ready, last_service_json).

        The Ready condition is only believed once the controller has OBSERVED the
        generation we wrote. Without that check this reports the previous revision's
        verdict: both upgrade paths PUT the service and call this immediately, and
        `get_service` runs before the first sleep, so the very first poll can read a
        `Ready=True` that Knative has not yet had a chance to invalidate. The caller
        then records `upgraded: True`, clears the failure marker, emits
        `personal_agent.updated` to the person's feed, and drops the row from the
        candidate set -- while Cloud Run keeps serving the old revision and the new one
        never boots. The three-attempt cap never engages, because no failure was ever
        recorded.

        This is the same distinction CLAUDE.md records for `Ready=True` not proving a
        pod serves, and the one the pod journey watcher already learned the hard way
        (`spec.template` is desired state; `status.traffic` is fact). `observedGeneration`
        is that line drawn on the service object itself.
        """
        deadline = time.monotonic() + timeout_s
        last: Optional[dict[str, Any]] = None
        while time.monotonic() < deadline:
            svc = self.get_service(name)
            if expected_uid is not None:
                self.require_service_uid(svc, expected_uid)
            if expected_revision_nonce is not None:
                metadata = (((svc or {}).get("spec") or {}).get("template") or {}).get(
                    "metadata"
                ) or {}
                actual_nonce = (metadata.get("annotations") or {}).get("hussh/restart-nonce")
                if actual_nonce != expected_revision_nonce:
                    raise RuntimeError("Cloud Run upgrade attempt changed or unverified")
                generation = ((svc or {}).get("metadata") or {}).get("generation")
                if (
                    not isinstance(generation, int)
                    or isinstance(generation, bool)
                    or generation < 1
                ):
                    raise RuntimeError("Cloud Run upgrade generation unverified")
            if expected_generation is not None and (
                ((svc or {}).get("metadata") or {}).get("generation") != expected_generation
            ):
                raise RuntimeError("Cloud Run acknowledged generation changed")
            last = svc
            if not self._status_is_current(svc):
                # A stale status is not a verdict. Keep polling rather than reading the
                # old revision's condition as though it described the new one.
                time.sleep(interval_s)
                continue
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
    def _status_is_current(svc: Optional[dict[str, Any]]) -> bool:
        """Has the controller reconciled the generation we wrote?

        `metadata.generation` is what we asked for; `status.observedGeneration` is how
        far the controller has got. Until they meet, everything under `status` --
        including the Ready condition -- describes the PREVIOUS revision.

        A service carrying no `metadata.generation` is judged as before, on the
        condition alone. Cloud Run Admin v1 always sends it, so that branch is for
        fakes and for any surface that does not report generations; treating an absent
        generation as "not yet observed" would hang every one of them until timeout.
        """
        desired = ((svc or {}).get("metadata") or {}).get("generation")
        if not isinstance(desired, int):
            return True
        observed = ((svc or {}).get("status") or {}).get("observedGeneration")
        return isinstance(observed, int) and observed >= desired

    @staticmethod
    def ready_failure(svc: Optional[dict[str, Any]]) -> Optional[str]:
        """The Ready condition's message when the revision DEFINITIVELY failed
        (Ready status == 'False'). None for True, Unknown, or absent -- a timeout
        with no verdict is a slow boot, not a failure.
        """
        conditions = ((svc or {}).get("status") or {}).get("conditions") or []
        ready = next((c for c in conditions if c.get("type") == "Ready"), None)
        if ready and ready.get("status") == "False":
            return str(ready.get("message") or "startup failed")
        return None

    @staticmethod
    def service_url(svc: Optional[dict[str, Any]]) -> Optional[str]:
        return ((svc or {}).get("status") or {}).get("url")
