"""Keep the person's registry to the current and previous agent image after an update.

Every update imports a new digest into the person's Basic registry and nothing ever
removed one: Basic has no retention policy, so after about 22 releases of 455 MiB the
10 GB included storage is passed and the person pays $0.10 per GB-month (pod
economics risk 8; ``byoc-azure.md`` "Registry retention").

This runs once, only after Azure's verdict confirmed the new revision is the ready
one (``azure_agent_upgrade._replace``, through the backend's
``prune_superseded_images``), under the person sign-in the update ran on. It deletes
a digest only when ALL hold:

* it is neither the image now running nor the one the update replaced;
* no revision of the agent, active or not, names it (ARM lists inactive revisions
  too, measured 2026-10-06), and the revision list was read whole;
* every manifest in the repository is a single image manifest (measured: the agent
  digests are OCI image manifests). An index anywhere stops the prune, so a child
  manifest of a kept index is never deleted.

KNOWN LIMIT: the agent sets no ``maxInactiveRevisions`` (measured null), so Azure
keeps old inactive revisions and each one keeps its digest protected by rule two.
Until that cap is set, this deletes only digests no revision names any more.

Best effort: any failure logs one line and returns; it never fails the update.

Registry access is the data plane (ARM has no manifest delete): the person's ARM
token is exchanged at the registry's own ``/oauth2/exchange`` for a repository-scoped
token, which is sent only to that ``*.azurecr.io`` host. Exchange, scoped token and
``/acr/v1/<repo>/_manifests`` were measured read-only on 2026-10-06; the delete
itself has not run live.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_container_app_renderer import POD_IMAGE_REPOSITORY

logger = logging.getLogger(__name__)

#: Only a registry setup named (``crhussh`` + 16 hex, ``resource_names``) gets the token.
#: Old images deleted per update at most; the rest wait for the next update.
_MAX_DELETES = 20
_IMAGE = re.compile(r"^(crhussh[0-9a-f]{16}\.azurecr\.io)/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$")
_DIGEST = re.compile(r"@(sha256:[0-9a-f]{64})$")
_BARE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_SINGLE_MANIFEST_TYPES = frozenset(
    {
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    }
)
#: One page is plenty: the prune runs on every update, so the backlog never builds.
_PAGE = 100
_TIMEOUT = 30


class PruneSkipped(RuntimeError):
    """A precondition did not hold; nothing was deleted."""


def _digest(image: Any) -> str:
    match = _DIGEST.search(str(image or ""))
    return match.group(1) if match else ""


def running_image(app: dict[str, Any]) -> str:
    """The image of the agent's ready revision, or "" while no single revision is ready."""
    properties = app.get("properties") or {}
    ready = properties.get("latestReadyRevisionName")
    if (
        not ready
        or ready != properties.get("latestRevisionName")
        or properties.get("provisioningState") != "Succeeded"
    ):
        return ""
    containers = (properties.get("template") or {}).get("containers") or []
    return str(containers[0].get("image") or "") if len(containers) == 1 else ""


def referenced_digests(revisions: Any) -> set[str]:
    """Every digest any revision names. Refuses a list it cannot read whole."""
    if not isinstance(revisions, dict) or not isinstance(revisions.get("value"), list):
        raise PruneSkipped("revisions unreadable")
    if revisions.get("nextLink"):
        raise PruneSkipped("revisions span more than one page")
    named: set[str] = set()
    for revision in revisions["value"]:
        template = (revision.get("properties") or {}).get("template") or {}
        for container in [
            *(template.get("containers") or []),
            *(template.get("initContainers") or []),
        ]:
            digest = _digest(container.get("image"))
            if not digest:
                raise PruneSkipped("a revision names an image without a digest")
            named.add(digest)
    return named


def prune_candidates(manifests: Any, *, protected: set[str]) -> list[str]:
    """Digests safe to delete: single image manifests that nothing protects."""
    if not isinstance(manifests, list):
        raise PruneSkipped("manifests unreadable")
    if any(m.get("mediaType") not in _SINGLE_MANIFEST_TYPES for m in manifests):
        raise PruneSkipped("the repository holds an index or an unknown manifest type")
    if any(not _BARE_DIGEST.match(str(m.get("digest") or "")) for m in manifests):
        raise PruneSkipped("a manifest has no well-formed digest")
    return [str(m["digest"]) for m in manifests if m.get("digest") not in protected]


class RegistryDataPlane:
    """One repository on one ``*.azurecr.io`` registry, on a person's ARM token.

    No redirect is followed: the exchange body carries the token, and a redirected
    POST would resend it to wherever the redirect pointed.
    """

    def __init__(self, server: str, repository: str, *, http: Any = None) -> None:
        self._server, self._repository = server, repository
        self._http = http
        self._token = ""

    def _session(self) -> Any:
        if self._http is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _form(self, path: str, data: dict[str, str], field: str) -> str:
        response = self._session().post(
            f"https://{self._server}{path}", data=data, timeout=_TIMEOUT, allow_redirects=False
        )
        if response.status_code != 200:
            raise PruneSkipped(f"registry {path} answered {response.status_code}")
        value = str((response.json() or {}).get(field) or "")
        if not value:
            raise PruneSkipped(f"registry {path} returned no {field}")
        return value

    def authorize(self, arm_token: str, tenant_id: str) -> None:
        """ARM token -> registry refresh token -> token scoped to this repository."""
        exchange = {
            "grant_type": "access_token",
            "service": self._server,
            "access_token": arm_token,
        }
        if tenant_id:
            exchange["tenant"] = tenant_id
        refresh = self._form("/oauth2/exchange", exchange, "refresh_token")
        self._token = self._form(
            "/oauth2/token",
            {
                "grant_type": "refresh_token",
                "service": self._server,
                "scope": f"repository:{self._repository}:metadata_read,delete",
                "refresh_token": refresh,
            },
            "access_token",
        )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def manifests(self) -> Any:
        url = f"https://{self._server}/acr/v1/{self._repository}/_manifests"
        response = self._session().get(
            url,
            params={"n": str(_PAGE)},
            headers=self._headers(),
            timeout=_TIMEOUT,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise PruneSkipped(f"manifest list answered {response.status_code}")
        return (response.json() or {}).get("manifests")

    def delete(self, digest: str) -> bool:
        """True when the registry accepted the delete; a missing digest is not an error."""
        url = f"https://{self._server}/v2/{self._repository}/manifests/{digest}"
        response = self._session().delete(
            url, headers=self._headers(), timeout=_TIMEOUT, allow_redirects=False
        )
        status = response.status_code
        if status not in (200, 202, 404):
            logger.info("azure_registry_prune.delete_refused digest=%s status=%s", digest, status)
        return status in (200, 202)


def _person_token() -> str:
    from hushh_mcp.services.user_azure_backend import current_jit_token  # noqa: PLC0415

    return str(current_jit_token())


def prune_superseded_images(
    arm: ArmClient,
    *,
    app_id: str,
    app: dict[str, Any],
    previous: str,
    tenant_id: str = "",
    token: Callable[[], str] = _person_token,
    registry: Optional[Callable[[str, str], RegistryDataPlane]] = None,
    expected: str = "",
) -> list[str]:
    """Delete superseded digests; returns what was deleted. Never raises.

    ``expected`` is the image this update installed: the prune runs only when the live
    app runs exactly that image, so the registry host is this agent's own, never one
    read back from an app body alone. At most ``_MAX_DELETES`` per update, so a slow
    registry cannot hold the update's lease for long.
    """
    try:
        current = running_image(app)
        match = _IMAGE.match(current)
        if not match or match.group(2) != POD_IMAGE_REPOSITORY or not _digest(previous):
            raise PruneSkipped("the running and previous images are not both pinned")
        if current != expected:
            raise PruneSkipped("the running image is not the one this update installed")
        arm_token = token()
        revisions = arm.get(
            f"{app_id}/revisions", api_version=API_VERSIONS["container_apps"], op="prune_images"
        )
        protected = {match.group(3), _digest(previous), *referenced_digests(revisions)}
        plane = (registry or RegistryDataPlane)(match.group(1), POD_IMAGE_REPOSITORY)
        plane.authorize(arm_token, tenant_id)
        candidates = prune_candidates(plane.manifests(), protected=protected)[:_MAX_DELETES]
        deleted = [d for d in candidates if plane.delete(d)]
    except Exception as exc:  # noqa: BLE001 - a full registry costs cents; a failed update does not
        logger.info("azure_registry_prune.skipped err=%s reason=%s", type(exc).__name__, exc)
        return []
    logger.info("azure_registry_prune.done deleted=%s kept=%s", len(deleted), len(protected))
    return deleted


class RegistryPruneHook:
    """``UserAzureBackend``'s update hook: its own agent and tenant, the person's sign-in.

    A mixin so the backend class stays inside its size budget; the update calls it
    once, after the live verdict (``azure_agent_upgrade._replace``).
    """

    _tenant: str

    @property
    def app_id(self) -> str:
        raise NotImplementedError

    def prune_superseded_images(
        self, arm: ArmClient, app: dict[str, Any], *, previous: str, expected: str
    ) -> list[str]:
        """After a confirmed update only: keep the current and previous image. Never raises."""
        return prune_superseded_images(
            arm,
            app_id=self.app_id,
            app=app,
            previous=previous,
            tenant_id=self._tenant,
            expected=expected,
        )


__all__ = [
    "PruneSkipped",
    "RegistryDataPlane",
    "RegistryPruneHook",
    "prune_candidates",
    "prune_superseded_images",
    "referenced_digests",
    "running_image",
]
