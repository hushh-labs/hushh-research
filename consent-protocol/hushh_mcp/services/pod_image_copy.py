"""Copy the pod image into the USER's own Artifact Registry, pinned by digest.

Pure REST -- the Docker Registry v2 API that Artifact Registry and gcr.io both speak,
authenticated with a Google OAuth bearer. No ``gcloud``, no Cloud Build: the same copier
works whatever cloud the control plane runs in, which is the portability property the
private-agent north star asks of every per-user primitive.

WHY THE ACTING IDENTITY IS NOT ``load_operator_credentials``
-----------------------------------------------------------
The copy pushes bytes INTO a project hushh does not own. It must therefore run as the
one scoped identity that project granted write to -- the consent-plane runtime SA -- and
never as the org-admin deploy key. ``load_operator_credentials`` prefers that org-admin
key when it is present (its own docstring calls it "the kind of finding a FedRAMP
assessor opens with"), so it is exactly the wrong loader here. Instead the acting
identity is resolved from the metadata server on GCP (the attached runtime SA) and from
Application Default Credentials off-GCP (localhost/CI, run AS the consent-plane SA), and
the CALLER asserts the resolved email equals the account granted the writer role before
any push. THAT assertion is the F3 control: a copy under broader authority is refused,
not used, so it is fail-closed by design wherever it runs.
"""

from __future__ import annotations

import json
from typing import Any, Optional

_METADATA_IDENTITY = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default"
)

# The manifest media types we ask for and understand. Both Docker v2 and OCI, single
# image AND multi-arch index -- a copier that assumed single-arch would silently drop
# platforms from a manifest list.
_MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
    ]
)
_MANIFEST_LIST_TYPES = frozenset(
    {
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.index.v1+json",
    }
)

_CHUNK = 1024 * 1024  # 1 MiB blob streaming chunks.


class ImageCopyError(RuntimeError):
    """A copy step failed. Never reported as a completed copy."""


def _requests() -> Any:
    import requests  # noqa: PLC0415

    return requests


def _acting_identity_via_metadata(session: Any) -> Optional[tuple[str, str]]:
    """(token, email) from the instance metadata server, or None if it is not there.

    On Cloud Run/GCE this returns the ATTACHED runtime service account and can never
    return a key file. Off-GCP (localhost/CI) the metadata host is unreachable, so this
    returns None and the caller falls back to ADC.
    """
    session = session or _requests()
    headers = {"Metadata-Flavor": "Google"}
    try:
        email_resp = session.get(f"{_METADATA_IDENTITY}/email", headers=headers, timeout=5)
        token_resp = session.get(f"{_METADATA_IDENTITY}/token", headers=headers, timeout=5)
    except Exception:  # noqa: BLE001 - metadata server absent off-GCP; fall through to ADC
        return None
    if getattr(email_resp, "status_code", 0) != 200 or getattr(token_resp, "status_code", 0) != 200:
        return None
    email = str(getattr(email_resp, "text", "")).strip()
    token = str((token_resp.json() or {}).get("access_token") or "")
    return (token, email) if (token and email) else None


def _acting_identity_via_adc() -> tuple[str, str]:
    """(token, email) from Application Default Credentials, for localhost/CI.

    Off-GCP the operator runs the backend AS, or impersonating, the consent-plane SA, so
    ADC resolves to it. If ADC instead resolves to something broader (an org-admin key,
    a user login), the email simply will not match the granted writer and the caller
    refuses -- that assertion, not this resolver, is the trust decision.
    """
    try:
        import google.auth  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise ImageCopyError(
            "no metadata server and google-auth is unavailable to resolve ADC"
        ) from exc
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(Request())
    email = str(getattr(creds, "service_account_email", "") or "")
    token = str(getattr(creds, "token", "") or "")
    return token, email


def attached_identity(session: Any = None) -> tuple[str, str]:
    """The (access_token, email) of the identity this runtime acts as.

    Resolved from the metadata server on Cloud Run/GCE (the attached runtime SA), and
    from Application Default Credentials off-GCP (localhost/CI, where the operator runs
    the backend AS or impersonating the consent-plane SA). Either way the CALLER
    (`UserGcpBackend._ensure_pod_image`) asserts the resolved email equals the account
    granted write on the destination repo BEFORE any push -- THAT assertion is the F3
    control. A wrong or broader identity (an org-admin key ADC happened to resolve) is
    refused, not used. So this resolves the acting identity honestly; it does not itself
    decide trust.
    """
    resolved = _acting_identity_via_metadata(session) or _acting_identity_via_adc()
    token, email = resolved
    if not token or not email:
        raise ImageCopyError(
            "could not resolve the acting runtime identity (metadata and ADC both empty)"
        )
    return token, email


def _parse_ref(ref: str) -> tuple[str, str, str]:
    """Split ``host/repository/name[:tag|@digest]`` into (host, repository, reference).

    ``repository`` is everything between the host and the tag/digest (Docker calls it
    the name); ``reference`` is the tag or the ``sha256:`` digest.
    """
    if not ref:
        raise ImageCopyError("empty image reference")
    reference = ""
    body = ref
    if "@" in ref:
        body, reference = ref.rsplit("@", 1)
    elif ":" in ref.rsplit("/", 1)[-1]:
        # A ':' in the LAST path segment is a tag; a ':' earlier (a port) is not.
        body, reference = ref.rsplit(":", 1)
    host, _, repository = body.partition("/")
    if not host or not repository:
        raise ImageCopyError(f"could not parse image reference: {ref}")
    return host, repository, reference


def _headers(token: str, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    h = {"Authorization": f"Bearer {token}"}
    if extra:
        h.update(extra)
    return h


def _manifest_url(host: str, repository: str, reference: str) -> str:
    return f"https://{host}/v2/{repository}/manifests/{reference}"


def _blob_url(host: str, repository: str, digest: str) -> str:
    return f"https://{host}/v2/{repository}/blobs/{digest}"


def resolve_source_digest(image_ref: str, token: str, session: Any = None) -> str:
    """The immutable ``sha256:...`` digest for a (possibly tag-pinned) source ref.

    A HEAD on the manifest returns the content digest without transferring the body. A
    ref that is already a digest is returned as-is.
    """
    session = session or _requests()
    host, repository, reference = _parse_ref(image_ref)
    if reference.startswith("sha256:"):
        return reference
    resp = session.get(
        _manifest_url(host, repository, reference),
        headers=_headers(token, {"Accept": _MANIFEST_ACCEPT}),
        timeout=60,
    )
    if getattr(resp, "status_code", 0) != 200:
        raise ImageCopyError(
            f"could not resolve source digest for {image_ref}: "
            f"HTTP {getattr(resp, 'status_code', '?')}"
        )
    digest = (getattr(resp, "headers", {}) or {}).get("Docker-Content-Digest", "")
    if not digest:
        raise ImageCopyError(f"source manifest for {image_ref} carried no content digest")
    return digest


def image_exists(image_ref_with_digest: str, token: str, session: Any = None) -> bool:
    """Does the destination already hold this exact digest? (the idempotency guard)."""
    session = session or _requests()
    host, repository, reference = _parse_ref(image_ref_with_digest)
    resp = session.request(
        "HEAD",
        _manifest_url(host, repository, reference),
        headers=_headers(token, {"Accept": _MANIFEST_ACCEPT}),
        timeout=30,
    )
    return getattr(resp, "status_code", 0) == 200


def _blob_exists(host: str, repository: str, digest: str, token: str, session: Any) -> bool:
    resp = session.request(
        "HEAD", _blob_url(host, repository, digest), headers=_headers(token), timeout=30
    )
    return getattr(resp, "status_code", 0) == 200


def _copy_blob(
    src: tuple[str, str],
    dst: tuple[str, str],
    digest: str,
    token: str,
    session: Any,
) -> None:
    """Stream one blob (config or layer) from source to destination, if absent there."""
    s_host, s_repo = src
    d_host, d_repo = dst
    if _blob_exists(d_host, d_repo, digest, token, session):
        return
    pull = session.get(
        _blob_url(s_host, s_repo, digest),
        headers=_headers(token),
        timeout=600,
        stream=True,
    )
    if getattr(pull, "status_code", 0) != 200:
        raise ImageCopyError(
            f"could not read blob {digest}: HTTP {getattr(pull, 'status_code', '?')}"
        )
    # Two-step upload: open a session, then PUT the bytes with the digest. The most
    # compatible push flow across Docker/AR registries.
    start = session.post(
        f"https://{d_host}/v2/{d_repo}/blobs/uploads/", headers=_headers(token), timeout=60
    )
    if getattr(start, "status_code", 0) not in (201, 202):
        raise ImageCopyError(
            f"could not start blob upload for {digest}: HTTP {getattr(start, 'status_code', '?')}"
        )
    location = (getattr(start, "headers", {}) or {}).get("Location", "")
    if not location:
        raise ImageCopyError(f"blob upload for {digest} returned no upload location")
    if location.startswith("/"):
        location = f"https://{d_host}{location}"
    sep = "&" if "?" in location else "?"
    body = (
        pull.iter_content(chunk_size=_CHUNK)
        if hasattr(pull, "iter_content")
        else getattr(pull, "content", b"")
    )
    put = session.put(
        f"{location}{sep}digest={digest}",
        headers=_headers(token, {"Content-Type": "application/octet-stream"}),
        data=body,
        timeout=600,
    )
    if getattr(put, "status_code", 0) not in (201, 204):
        raise ImageCopyError(
            f"could not finish blob upload for {digest}: HTTP {getattr(put, 'status_code', '?')}"
        )


def _get_manifest(
    host: str, repository: str, reference: str, token: str, session: Any
) -> tuple[bytes, str]:
    resp = session.get(
        _manifest_url(host, repository, reference),
        headers=_headers(token, {"Accept": _MANIFEST_ACCEPT}),
        timeout=60,
    )
    if getattr(resp, "status_code", 0) != 200:
        raise ImageCopyError(
            f"could not read manifest {reference}: HTTP {getattr(resp, 'status_code', '?')}"
        )
    content = getattr(resp, "content", b"") or b""
    media_type = (getattr(resp, "headers", {}) or {}).get("Content-Type", "").split(";")[0].strip()
    return content, media_type


def _put_manifest(
    host: str,
    repository: str,
    reference: str,
    body: bytes,
    media_type: str,
    token: str,
    session: Any,
) -> None:
    resp = session.put(
        _manifest_url(host, repository, reference),
        headers=_headers(token, {"Content-Type": media_type}),
        data=body,
        timeout=120,
    )
    if getattr(resp, "status_code", 0) not in (201, 202):
        raise ImageCopyError(
            f"could not write manifest {reference}: HTTP {getattr(resp, 'status_code', '?')}"
        )


def _copy_single_manifest(
    src: tuple[str, str],
    dst: tuple[str, str],
    digest: str,
    token: str,
    session: Any,
) -> None:
    """Copy one non-list manifest: its config blob, every layer blob, then the manifest.

    Manifest LAST, always: Artifact Registry accepts a manifest only once the blobs it
    references exist, so a manifest that lands is proof the image is whole. An interrupted
    copy therefore leaves no readable image, and the next run's HEAD-miss retries cleanly.
    """
    body, media_type = _get_manifest(src[0], src[1], digest, token, session)
    manifest = json.loads(body or b"{}")
    blobs = []
    config = manifest.get("config") or {}
    if config.get("digest"):
        blobs.append(config["digest"])
    for layer in manifest.get("layers") or []:
        if layer.get("digest"):
            blobs.append(layer["digest"])
    for blob_digest in blobs:
        _copy_blob(src, dst, blob_digest, token, session)
    _put_manifest(dst[0], dst[1], digest, body, media_type, token, session)


def copy_image(source_ref: str, dest_ref: str, token: str, session: Any = None) -> None:
    """Copy ``source_ref`` to ``dest_ref`` (a digest-pinned destination), pure REST.

    Handles a multi-arch manifest LIST by copying each child manifest (and its blobs)
    before writing the list -- so no platform is dropped and the list only lands once
    every image it names is present.
    """
    session = session or _requests()
    s_host, s_repo, _ = _parse_ref(source_ref)
    d_host, d_repo, d_ref = _parse_ref(dest_ref)
    if not d_ref.startswith("sha256:"):
        raise ImageCopyError("destination must be pinned by digest")
    src, dst = (s_host, s_repo), (d_host, d_repo)

    body, media_type = _get_manifest(s_host, s_repo, d_ref, token, session)
    if media_type in _MANIFEST_LIST_TYPES:
        index = json.loads(body or b"{}")
        for entry in index.get("manifests") or []:
            child = entry.get("digest")
            if child:
                _copy_single_manifest(src, dst, child, token, session)
        _put_manifest(d_host, d_repo, d_ref, body, media_type, token, session)
    else:
        _copy_single_manifest(src, dst, d_ref, token, session)


__all__ = [
    "ImageCopyError",
    "attached_identity",
    "copy_image",
    "image_exists",
    "resolve_source_digest",
]
