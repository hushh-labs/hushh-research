"""Where Connect Azure's ``importImage`` reads the agent image from, and as whom.

The person's registry pulls the approved digest straight from Hussh's private
Artifact Registry repository. Azure needs a credential for that read, and it is
never the hub's own runtime token: that token carries everything the hub may do in
Google Cloud, and ``importImage`` hands its source credential to Azure.

Instead the hub impersonates ONE dedicated reader service account,
``HUSSH_POD_IMAGE_READER_SA``, through IAM Credentials ``generateAccessToken``
(900 s, ``cloud-platform`` scope). The token carries whatever that account is
granted, for at most 15 minutes; the hub does not check those grants. The only
grant must be Artifact Registry reader on the repository holding the pod release.
On a ``gcr.io/<project>`` source that repository also holds the hub and web
images, so the token can pull them too: logged on every preflight as
``reader_on_shared_repository`` and recorded under Known gaps in
``docs/reference/architecture/byoc-azure.md``. The token is minted at the moment
of the import call and exists only in that request body.

* A Google token is only ever offered to a Google registry host; a foreign registry
  must be public (proven by an anonymous read) or it is refused.
* With no reader configured, a Google source must be public, or the setup is
  refused BEFORE anything is created, with a typed refusal naming the missing
  configuration.
* No token is logged or put in an exception message.

Hub deployment configuration, not pod behaviour, and not a secret.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Callable, Literal, Optional

from hushh_mcp.services.azure_setup_applier import AzureSetupRefused

logger = logging.getLogger(__name__)

READER_SA_ENV = "HUSSH_POD_IMAGE_READER_SA"
#: Where Azure imports the approved digest from, when not the hub's own pod image
#: repository: a dedicated release repository the reader alone is granted.
RELEASE_REPOSITORY_ENV = "HUSSH_AZURE_POD_IMAGE_REPOSITORY"
READER_TOKEN_LIFETIME_SECONDS = 900
READER_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
#: The username Google registries expect with an OAuth access token as the password.
REGISTRY_USERNAME = "oauth2accesstoken"

_IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts"
_GOOGLE_REGISTRY = re.compile(r"^(?:[a-z0-9-]+-docker\.pkg\.dev|(?:[a-z]+\.)?gcr\.io)$")
_PROJECT_WIDE_REGISTRY = re.compile(r"^(?:[a-z]+\.)?gcr\.io$")
_SERVICE_ACCOUNT = re.compile(
    r"^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9.-]+\.iam\.gserviceaccount\.com$"
)
_CHALLENGE_PARAM = re.compile(r'(\w+)="([^"]*)"')
_MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)

ImportAccess = Literal["reader", "public"]
HubIdentity = Callable[[], tuple[str, str]]


def _session(session: Any) -> Any:
    if session is not None:
        return session
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    return requests


def _hub_identity(hub_identity: Optional[HubIdentity]) -> tuple[str, str]:
    if hub_identity is not None:
        return hub_identity()
    from hushh_mcp.services.pod_image_copy import attached_identity  # noqa: PLC0415

    token, email = attached_identity()
    return str(token), str(email)


def is_google_registry(host: str) -> bool:
    """Artifact Registry or Container Registry: the only hosts a Google token may reach."""
    return bool(_GOOGLE_REGISTRY.match(str(host or "").strip().lower()))


def is_project_wide_registry(host: str) -> bool:
    """A ``gcr.io`` host: every image under ``gcr.io/<project>/`` is ONE repository.

    A reader granted there can pull every image of the project, the hub and web
    images included, not only the pod release.
    """
    return bool(_PROJECT_WIDE_REGISTRY.match(str(host or "").strip().lower()))


def release_source(source: str) -> str:
    """The same approved digest, read from the dedicated release repository if one is set.

    A digest names exact bytes, so ``<release repository>@<digest>`` is the approved
    image wherever it is read from. That lets the reader be granted one pod-only
    repository instead of the project-wide ``gcr.io`` one. A digest missing from the
    release repository fails the import preflight with ``IMAGE_NOT_PUBLISHED``, before
    any sign-in. Setup and the approved update both import through this mapping.
    """
    repository = (os.getenv(RELEASE_REPOSITORY_ENV) or "").strip().rstrip("/")
    if not repository:
        return source
    host, _, path = repository.partition("/")
    if not is_google_registry(host) or not path or "@" in path or ":" in path:
        raise AzureSetupRefused(
            f"{RELEASE_REPOSITORY_ENV} is not a registry repository",
            code="IMAGE_REPOSITORY_MISCONFIGURED",
        )
    digest = source.rpartition("@")[2]
    return f"{repository}@{digest}"


def reader_service_account() -> str:
    """The configured reader account, "" when unset; a malformed value is refused."""
    value = (os.getenv(READER_SA_ENV) or "").strip().removeprefix("serviceAccount:")
    if value and not _SERVICE_ACCOUNT.match(value):
        raise AzureSetupRefused(
            f"{READER_SA_ENV} is not a service account email", code="IMAGE_READER_MISCONFIGURED"
        )
    return value


def _reader_unavailable() -> AzureSetupRefused:
    return AzureSetupRefused(
        "Hussh could not mint the short-lived image reader credential",
        code="IMAGE_READER_UNAVAILABLE",
    )


def _generate_access_token(reader: str, hub_token: str, http: Any) -> tuple[int, str]:
    """(HTTP status, minted token or "") from IAM Credentials ``generateAccessToken``."""
    response = http.post(
        f"{_IAM_CREDENTIALS}/{reader}:generateAccessToken",
        headers={"Authorization": f"Bearer {hub_token}"},
        json={"scope": [READER_SCOPE], "lifetime": f"{READER_TOKEN_LIFETIME_SECONDS}s"},
        timeout=30,
    )
    status = int(getattr(response, "status_code", 0) or 0)
    body = (response.json() or {}) if status == 200 else {}
    return status, str(body.get("accessToken") or "")


def mint_reader_token(
    reader: str, *, session: Any = None, hub_identity: Optional[HubIdentity] = None
) -> str:
    """A 900 s access token for ``reader``, minted by the hub's identity impersonating it.

    Every failure is the typed ``IMAGE_READER_UNAVAILABLE``; only an exception's type
    and the HTTP status are logged, never a token.
    """
    try:
        hub_token, hub_email = _hub_identity(hub_identity)
    except Exception as exc:  # noqa: BLE001 - no acting identity is a typed refusal
        logger.warning("azure_image_source.hub_identity_unavailable err=%s", type(exc).__name__)
        raise _reader_unavailable() from exc
    if hub_email.strip().lower() == reader.lower():
        raise AzureSetupRefused(
            f"{READER_SA_ENV} must be a dedicated reader, not the hub's own identity",
            code="IMAGE_READER_IS_HUB",
        )
    try:
        status, token = _generate_access_token(reader, hub_token, _session(session))
    except Exception as exc:  # noqa: BLE001 - an unreachable IAM is a typed refusal
        logger.warning("azure_image_source.reader_token_failed err=%s", type(exc).__name__)
        raise _reader_unavailable() from exc
    if not token or token == hub_token:
        logger.warning("azure_image_source.reader_token_refused http=%s", status)
        raise _reader_unavailable()
    return token


def import_credentials(
    source_registry: str, *, session: Any = None, hub_identity: Optional[HubIdentity] = None
) -> Optional[Callable[[], dict[str, str]]]:
    """The ``importImage`` source credential, minted when called; None for no credential.

    None when no reader is configured or the registry is not Google's: a Google token
    never reaches a foreign registry, and an unauthenticated import then succeeds only
    for a public source (``require_import_access`` proves that before setup begins).
    """
    reader = reader_service_account()
    if not reader or not is_google_registry(source_registry):
        return None

    def _credentials() -> dict[str, str]:
        token = mint_reader_token(reader, session=session, hub_identity=hub_identity)
        return {"username": REGISTRY_USERNAME, "password": token}

    return _credentials


def _anonymous_token(challenge: str, repository: str, http: Any) -> str:
    """A registry's anonymous pull token from its ``Bearer`` challenge, or ""."""
    if not challenge.lower().startswith("bearer "):
        return ""
    params = dict(_CHALLENGE_PARAM.findall(challenge))
    realm = params.get("realm", "")
    if not realm.startswith("https://"):
        return ""
    response = http.get(
        realm,
        params={"service": params.get("service", ""), "scope": f"repository:{repository}:pull"},
        timeout=10,
    )
    if getattr(response, "status_code", 0) != 200:
        return ""
    body = response.json() or {}
    return str(body.get("token") or body.get("access_token") or "")


def _head_manifest(http: Any, registry: str, repository: str, digest: str, token: str = "") -> Any:
    headers = {"Accept": _MANIFEST_ACCEPT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"https://{registry}/v2/{repository}/manifests/{digest}"
    return http.head(url, headers=headers, timeout=10)


def source_is_public(registry: str, repository: str, digest: str, *, session: Any = None) -> bool:
    """Whether anyone can read this digest with no credential (the registry token dance)."""
    http = _session(session)
    try:
        response = _head_manifest(http, registry, repository, digest)
        if getattr(response, "status_code", 0) == 401:
            challenge = str((getattr(response, "headers", None) or {}).get("WWW-Authenticate", ""))
            token = _anonymous_token(challenge, repository, http)
            if not token:
                return False
            response = _head_manifest(http, registry, repository, digest, token)
    except Exception as exc:  # noqa: BLE001 - an unreachable source is not a public one
        logger.info("azure_image_source.anonymous_probe_failed err=%s", type(exc).__name__)
        return False
    return getattr(response, "status_code", 0) == 200


def _read_status(token: str, registry: str, repository: str, digest: str, session: Any) -> int:
    """HTTP status of this token's manifest read; 0 when unreachable or not a Google host."""
    if not is_google_registry(registry):
        return 0
    try:
        response = _head_manifest(_session(session), registry, repository, digest, token)
    except Exception as exc:  # noqa: BLE001 - an unreachable source is not a readable one
        logger.info("azure_image_source.reader_probe_failed err=%s", type(exc).__name__)
        return 0
    return int(getattr(response, "status_code", 0) or 0)


def readable_with(
    token: str, registry: str, repository: str, digest: str, *, session: Any = None
) -> bool:
    """Whether this Google token can read the digest. Only ever sent to a Google registry."""
    return _read_status(token, registry, repository, digest, session) == 200


def _reader_refusal(status: int) -> AzureSetupRefused:
    """Why the reader's read failed, worded so the remedy never widens its grant.

    Artifact Registry answers 404 only to a caller allowed to read the repository; one
    without the grant gets 403 whether or not the digest exists (measured on the dev
    release repository, 2026-10-05). So a 404 means the digest was never published
    there (the dev deploy publishes each release digest). Telling an operator to grant
    the reader more in that case would invite the exact widening the founder did not
    approve.
    """
    if status == 404:
        return AzureSetupRefused(
            "This agent release is not yet in the repository your subscription imports "
            "from; it appears there when the release is published.",
            code="IMAGE_NOT_PUBLISHED",
        )
    return AzureSetupRefused(
        f"{READER_SA_ENV} cannot read the agent image; grant it Artifact Registry "
        "reader on the pod image repository.",
        code="IMAGE_READER_CANNOT_READ",
    )


def require_import_access(
    registry: str,
    repository: str,
    digest: str,
    *,
    session: Any = None,
    hub_identity: Optional[HubIdentity] = None,
) -> ImportAccess:
    """Prove the person's registry will be able to import this digest, before setup.

    ``reader``: a Google source and a reader whose freshly minted token read this
    digest (then discarded; the import mints its own). ``public``: readable with no
    credential.
    Anything else is a typed refusal raised before any Azure resource is written.
    """
    reader = reader_service_account()
    if reader and is_google_registry(registry):
        if is_project_wide_registry(registry):
            logger.warning(
                "azure_image_source.reader_on_shared_repository host=%s "
                "(the reader's token can pull every image in this project's registry)",
                registry.strip().lower(),
            )
        token = mint_reader_token(reader, session=session, hub_identity=hub_identity)
        status = _read_status(token, registry, repository, digest, session)
        if status != 200:
            raise _reader_refusal(status)
        return "reader"
    if source_is_public(registry, repository, digest, session=session):
        return "public"
    if is_google_registry(registry):
        raise AzureSetupRefused(
            f"The agent image is private and {READER_SA_ENV} is not configured on this "
            "deployment, so your subscription could not copy it.",
            code="IMAGE_SOURCE_NOT_CONFIGURED",
        )
    raise AzureSetupRefused(
        "The agent image's registry is private and is not one Hussh can grant read access to.",
        code="IMAGE_SOURCE_UNSUPPORTED",
    )


__all__ = [
    "READER_SA_ENV",
    "READER_TOKEN_LIFETIME_SECONDS",
    "READER_SCOPE",
    "REGISTRY_USERNAME",
    "RELEASE_REPOSITORY_ENV",
    "ImportAccess",
    "import_credentials",
    "is_google_registry",
    "is_project_wide_registry",
    "mint_reader_token",
    "readable_with",
    "release_source",
    "reader_service_account",
    "require_import_access",
    "source_is_public",
]
