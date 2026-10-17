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

import hashlib
import json
import re
from typing import Any, Optional
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

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
    """A copy step failed. Never reported as a completed copy.

    Carries WHICH side refused and with what status, because the caller has to tell two
    very different failures apart. A 403 writing to the DESTINATION is the person's own
    Artifact Registry declining a push, which the substrate step
    `artifact_repo_grant_copy_writer` exists to permit -- so re-running their substrate
    and retrying can genuinely fix it. A 403 reading the SOURCE is hushh's own registry,
    where re-granting anything in their project would change nothing and would only hide
    the real problem behind a pointless retry.

    Structured rather than parsed out of the message: a heal that triggers on a substring
    is one reworded error away from either never firing or firing on everything.
    """

    def __init__(self, message: str, *, status: Optional[int] = None, side: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.side = side

    @property
    def heals_with_substrate(self) -> bool:
        """Would re-applying THIS person's substrate plausibly fix this?

        Read by the orchestrator through `getattr`, so the common layer can ask the
        question without importing a cloud-specific type or naming a provider --
        the same shape `UserCloud.blocks_provisioning` uses.
        """
        return self.status == 403 and self.side == "destination"


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

    Verify a tagged manifest against its content-digest header. An already pinned
    reference is syntax-checked here; its bytes are verified when downloaded.
    """
    session = session or _requests()
    host, repository, reference = _parse_ref(image_ref)
    if reference.startswith("sha256:"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", reference):
            raise ImageCopyError("invalid source manifest digest")
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
    content = getattr(resp, "content", b"") or b""
    if not isinstance(content, bytes) or digest != "sha256:" + hashlib.sha256(content).hexdigest():
        raise ImageCopyError("source manifest content digest unverified", side="source")
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
            f"could not read blob {digest}: HTTP {getattr(pull, 'status_code', '?')}",
            status=getattr(pull, "status_code", None),
            side="source",
        )
    # Two-step upload: open a session, then PUT the bytes with the digest. The most
    # compatible push flow across Docker/AR registries.
    upload_base = f"https://{d_host}/v2/{d_repo}/blobs/uploads/"
    start = session.post(upload_base, headers=_headers(token), timeout=60, allow_redirects=False)
    if getattr(start, "status_code", 0) not in (201, 202):
        raise ImageCopyError(
            f"could not start blob upload for {digest}: HTTP {getattr(start, 'status_code', '?')}",
            status=getattr(start, "status_code", None),
            side="destination",
        )
    location = (getattr(start, "headers", {}) or {}).get("Location", "")
    if not location:
        raise ImageCopyError(f"blob upload for {digest} returned no upload location")
    # An upload Location is provider input, not permission to forward credentials.
    try:
        if not isinstance(location, str) or any(ord(char) <= 32 for char in location):
            raise ValueError("invalid upload location")
        target = urlsplit(urljoin(upload_base, location))
        if (
            target.scheme != "https"
            or target.netloc != d_host
            or target.username is not None
            or target.password is not None
            or target.fragment
        ):
            raise ValueError("foreign upload location")
    except ValueError:
        raise ImageCopyError("registry upload location outside destination authority") from None
    query = target.query + ("&" if target.query else "") + f"digest={digest}"
    location = urlunsplit((target.scheme, target.netloc, target.path, query, ""))
    body = (
        pull.iter_content(chunk_size=_CHUNK)
        if hasattr(pull, "iter_content")
        else getattr(pull, "content", b"")
    )
    put = session.put(
        location,
        headers=_headers(token, {"Content-Type": "application/octet-stream"}),
        data=body,
        timeout=600,
        allow_redirects=False,
    )
    if getattr(put, "status_code", 0) not in (201, 204):
        raise ImageCopyError(
            f"could not finish blob upload for {digest}: HTTP {getattr(put, 'status_code', '?')}",
            status=getattr(put, "status_code", None),
            side="destination",
        )


def _get_manifest(
    host: str, repository: str, reference: str, token: str, session: Any
) -> tuple[bytes, str]:
    resp = session.get(
        _manifest_url(host, repository, reference),
        headers=_headers(token, {"Accept": _MANIFEST_ACCEPT}),
        timeout=60,
        allow_redirects=False,
    )
    if getattr(resp, "status_code", 0) != 200:
        raise ImageCopyError(
            f"could not read manifest {reference}: HTTP {getattr(resp, 'status_code', '?')}",
            status=getattr(resp, "status_code", None),
            side="source",
        )
    content = getattr(resp, "content", b"") or b""
    if (
        not isinstance(content, bytes)
        or reference != "sha256:" + hashlib.sha256(content).hexdigest()
    ):
        raise ImageCopyError("source manifest content digest unverified", side="source")
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
            f"could not write manifest {reference}: HTTP {getattr(resp, 'status_code', '?')}",
            status=getattr(resp, "status_code", None),
            side="destination",
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


def _manifest_graph(
    host: str, repo: str, root: str, token: str, session: Any
) -> list[dict[str, Any]]:
    pending = [(root, 0)]
    seen: dict[str, list[str]] = {}
    while pending:
        digest, depth = pending.pop()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ImageCopyError("manifest graph digest invalid")
        if digest in seen:
            continue
        if depth > 4 or len(seen) >= 128:
            raise ImageCopyError("manifest graph limit exceeded")
        body, media = _get_manifest(host, repo, digest, token, session)
        if media not in _MANIFEST_LIST_TYPES and media not in {
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        }:
            raise ImageCopyError("manifest graph media type unsupported")
        manifest = json.loads(body)
        if not isinstance(manifest, dict):
            raise ImageCopyError("manifest graph malformed")
        children = []
        if media in _MANIFEST_LIST_TYPES:
            entries = manifest.get("manifests")
            if not isinstance(entries, list) or not entries or len(entries) > 128:
                raise ImageCopyError("manifest graph children malformed")
            for entry in entries:
                child = entry.get("digest") if isinstance(entry, dict) else None
                if not isinstance(child, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", child):
                    raise ImageCopyError("manifest graph child digest invalid")
                children.append(child)
                pending.append((child, depth + 1))
        seen[digest] = sorted(set(children))
    return [{"digest": digest, "children": seen[digest]} for digest in sorted(seen)]


def observe_common_image_build(
    *,
    project: str,
    location: str,
    build_id: str,
    source_ref: str,
    token: str,
    session: Any,
    source_verifier: Any = None,
) -> dict[str, Any]:
    """Read successful pod-build provenance and its digest-verified source graph.

    Build configuration declares its source commit; it does not prove source custody.
    This is build/output evidence, not repository ownership or erasure authority.
    Raw build records and logs stay in memory; only bounded provenance is returned.
    """
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", location)
        or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", build_id)
    ):
        raise ImageCopyError("build identity invalid")
    host, repo, reference = _parse_ref(source_ref)
    if host != "gcr.io" or repo != f"{project}/consent-protocol-pod":
        raise ImageCopyError("build source repository unsupported")
    build_name = f"projects/{project}/locations/{location}/builds/{build_id}"
    response = session.get(
        f"https://cloudbuild.googleapis.com/v1/{build_name}",
        headers=_headers(token),
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ImageCopyError("build evidence unavailable")
    build = response.json()
    if (
        not isinstance(build, dict)
        or "error" in build
        or build.get("id") != build_id
        or build.get("projectId") != project
        or build.get("status") != "SUCCESS"
    ):
        raise ImageCopyError("successful build identity unverified")
    substitutions = build.get("substitutions") or {}
    commit = substitutions.get("_DEPLOY_SHA")
    if (
        not isinstance(commit, str)
        or not re.fullmatch(r"[0-9a-f]{40}", commit)
        or substitutions.get("_BUILD_POD_IMAGE") != "true"
    ):
        raise ImageCopyError("pod build source unverified")
    if (
        substitutions.get("_DEPLOY_ENV") != "dev"
        or substitutions.get("_IMAGE_TAG") != f"dev-{commit}"
    ):
        raise ImageCopyError("pod build environment unverified")
    steps = build.get("steps") or []
    if sum(isinstance(step, dict) and step.get("id") == "build-pod-image" for step in steps) != 1:
        raise ImageCopyError("pod build step unverified")
    query = f'resource.type="build" AND resource.labels.project_id="{project}" AND resource.labels.build_id="{build_id}" AND textPayload:"exporting manifest list"'
    page_token = None
    seen_tokens: set[str] = set()
    digests: set[str] = set()
    for _ in range(20):
        payload: dict[str, Any] = {
            "resourceNames": [f"projects/{project}"],
            "filter": query,
            "pageSize": 100,
        }
        if page_token:
            payload["pageToken"] = page_token
        response = session.post(
            "https://logging.googleapis.com/v2/entries:list",
            headers=_headers(token),
            json=payload,
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise ImageCopyError("build log evidence unavailable")
        page = response.json()
        if (
            not isinstance(page, dict)
            or "error" in page
            or not isinstance(page.get("entries", []), list)
        ):
            raise ImageCopyError("build log evidence malformed")
        for entry in page.get("entries", []):
            resource = entry.get("resource") or {}
            labels = resource.get("labels") or {}
            step = (entry.get("labels") or {}).get("build_step", "")
            if (
                resource.get("type") != "build"
                or labels.get("build_id") != build_id
                or labels.get("project_id") != project
            ):
                raise ImageCopyError("build log identity mismatch")
            if not re.fullmatch(r'Step #[0-9]+ - "build-pod-image"', step):
                continue
            text = entry.get("textPayload", "")
            digests.update(
                re.findall(r"exporting manifest list (sha256:[0-9a-f]{64})(?=\s|$)", text)
            )
        page_token = page.get("nextPageToken")
        if not page_token:
            break
        if not isinstance(page_token, str) or len(page_token) > 8192 or page_token in seen_tokens:
            raise ImageCopyError("build log pagination invalid")
        seen_tokens.add(page_token)
    else:
        raise ImageCopyError("build log pagination incomplete")
    if len(digests) != 1:
        raise ImageCopyError("pod build output ambiguous or absent")
    digest = next(iter(digests))
    if reference.startswith("sha256:") and reference != digest:
        raise ImageCopyError("pod build digest mismatch")
    source_evidence = source_verifier(build) if source_verifier is not None else None
    return {
        "buildName": build_name,
        "sourceComparison": source_evidence,
        "declaredSourceCommit": commit,
        "sourceRepository": f"{host}/{repo}",
        "rootDigest": digest,
        "manifestGraph": _manifest_graph(host, repo, digest, token, session),
        "status": "SUCCESS",
    }


def compare_repository_build_outputs(
    *, inventory: dict[str, Any], comparison: dict[str, Any], builds: list[dict[str, Any]]
) -> dict[str, Any]:
    """Match observed build outputs without inferring governed source provenance.

    Inputs must come from the authenticated observers in this module, not a
    caller-supplied assertion. Unfinished copies stream the same application
    blobs; this does not claim a physical-byte inventory or repository deletion.
    """
    expected = {image["uri"] for image in inventory["images"]}
    results = comparison.get("images", [])
    if (
        inventory.get("paginationComplete") is not True
        or len(results) != len(expected)
        or {item.get("uri") for item in results} != expected
    ):
        raise ImageCopyError("image classification coverage incomplete")
    approved: dict[str, dict[str, Any]] = {}
    for build in builds:
        if build.get("status") != "SUCCESS" or build.get("sourceRepository") != comparison.get(
            "sourceRepository"
        ):
            raise ImageCopyError("image build source mismatch")
        for node in build["manifestGraph"]:
            approved[node["digest"]] = node
    for result in results:
        graph = result.get("manifestGraph") or []
        if (
            result.get("manifestEquivalent") is not True
            or not graph
            or any(approved.get(node["digest"]) != node for node in graph)
        ):
            raise ImageCopyError("repository image lacks common build evidence")
    return {
        "repositoryIdentity": inventory["repositoryIdentity"],
        "classification": "unresolved",
        "buildOutputMatch": True,
        "sourceProvenanceVerified": False,
        "images": results,
        "builds": builds,
        "scope": "observed_application_manifests",
        "physicalByteErasure": False,
    }


def compare_repository_images(
    *,
    inventory: dict[str, Any],
    source_ref: str,
    source_token: str,
    destination_token: str,
    session: Any,
) -> dict[str, Any]:
    """Compare observed digests to one declared source; never infer ownership.

    Both sides are read by digest. Matching graphs prove manifest equivalence;
    blob contents, trusted build provenance and unreferenced uploads remain unchecked.
    """
    source_host, source_repo, _ = _parse_ref(source_ref)
    if not (
        source_host in {"gcr.io", "us.gcr.io", "eu.gcr.io", "asia.gcr.io"}
        or re.fullmatch(r"[a-z][a-z0-9-]*-docker\.pkg\.dev", source_host)
    ):
        raise ImageCopyError("application source registry unsupported")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._/-]*", source_repo):
        raise ImageCopyError("application source repository invalid")
    identity = inventory.get("repositoryIdentity") or {}
    scope = re.fullmatch(
        r"projects/([a-z][a-z0-9-]{4,28}[a-z0-9])/locations/([a-z][a-z0-9-]*)/repositories/one-pod",
        str(identity.get("name", "")),
    )
    if scope is None or inventory.get("paginationComplete") is not True:
        raise ImageCopyError("repository inventory incomplete")
    destination_prefix = f"{scope[2]}-docker.pkg.dev/{scope[1]}/one-pod/"
    images = inventory.get("images")
    if not isinstance(images, list) or len(images) > 10000:
        raise ImageCopyError("repository inventory malformed")

    results = []
    for image in images:
        uri = image.get("uri") if isinstance(image, dict) else None
        if not isinstance(uri, str) or not uri.startswith(destination_prefix):
            raise ImageCopyError("repository image scope invalid")
        host, repo, digest = _parse_ref(uri)
        # The copy path owns this package only. Other packages stay unresolved.
        if repo != f"{scope[1]}/one-pod/consent-protocol-pod":
            results.append(
                {"uri": uri, "manifestEquivalent": False, "reason": "unclassified_package"}
            )
            continue
        try:
            source_graph = _manifest_graph(source_host, source_repo, digest, source_token, session)
            destination_graph = _manifest_graph(host, repo, digest, destination_token, session)
            if source_graph != destination_graph:
                raise ImageCopyError("manifest graph mismatch")
            results.append({"uri": uri, "manifestEquivalent": True, "manifestGraph": source_graph})
        except Exception as exc:
            results.append({"uri": uri, "manifestEquivalent": False, "reason": type(exc).__name__})
    return {
        "sourceRepository": f"{source_host}/{source_repo}",
        "images": results,
        "classification": "unresolved",
        "unreferencedUploadsChecked": False,
        "blobContentsChecked": False,
    }


def observe_repository_images(
    *, project: str, region: str, expected_identity: dict[str, str], token: str, session: Any
) -> dict[str, Any]:
    """Read a captured repository incarnation without granting cleanup authority.

    Pagination is bounded and complete or raises. Repository identity is checked
    on both sides of listing. This is not an atomic image snapshot, an ownership
    claim, or an inventory of incomplete uploads/unreferenced blobs.
    """
    from hushh_mcp.services.byoc_substrate import _artifact_repository_creation_identity

    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project) or not re.fullmatch(
        r"[a-z][a-z0-9-]{0,62}", region
    ):
        raise ImageCopyError("repository scope invalid")
    name = f"projects/{project}/locations/{region}/repositories/one-pod"
    identity = _artifact_repository_creation_identity(expected_identity, name)
    if identity is None or identity != expected_identity:
        raise ImageCopyError("repository identity required")
    base = f"https://artifactregistry.googleapis.com/v1/{name}"

    def read(url: str, params: dict | None = None) -> dict:
        response = session.get(
            url, headers=_headers(token), params=params, timeout=30, allow_redirects=False
        )
        if response.status_code != 200:
            raise ImageCopyError("repository inventory unavailable")
        body = response.json()
        if not isinstance(body, dict) or "error" in body:
            raise ImageCopyError("repository inventory malformed")
        return body

    def verify_identity() -> None:
        if _artifact_repository_creation_identity(read(base), name) != identity:
            raise ImageCopyError("repository incarnation changed")

    verify_identity()
    images: dict[str, dict[str, str]] = {}
    seen_tokens: set[str] = set()
    page_token = ""
    uri_prefix = f"{region}-docker.pkg.dev/{project}/one-pod/"
    for _ in range(100):
        page = read(f"{base}/dockerImages", {"pageSize": 100, "pageToken": page_token})
        entries = page.get("dockerImages", [])
        if not isinstance(entries, list):
            raise ImageCopyError("repository image list malformed")
        for entry in entries:
            image_name = entry.get("name") if isinstance(entry, dict) else None
            uri = entry.get("uri") if isinstance(entry, dict) else None
            if (
                not isinstance(image_name, str)
                or not isinstance(uri, str)
                or len(image_name) > 2048
                or len(uri) > 2048
                or not image_name.startswith(name + "/dockerImages/")
                or not uri.startswith(uri_prefix)
                or unquote(image_name.removeprefix(name + "/dockerImages/"))
                != uri.removeprefix(uri_prefix)
                or not re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", uri.removeprefix(uri_prefix))
                or unquote(image_name) in images
            ):
                raise ImageCopyError("repository image identity unresolved")
            canonical_name = unquote(image_name)
            images[canonical_name] = {"name": canonical_name, "uri": uri}
            if len(images) > 10000:
                raise ImageCopyError("repository inventory limit exceeded")
        next_token = page.get("nextPageToken", "")
        if not isinstance(next_token, str) or len(next_token) > 8192:
            raise ImageCopyError("repository pagination malformed")
        if not next_token:
            verify_identity()
            return {
                "repositoryIdentity": identity,
                "images": [images[key] for key in sorted(images)],
                "paginationComplete": True,
                "classification": "unresolved",
            }
        if next_token in seen_tokens:
            raise ImageCopyError("repository pagination repeated")
        seen_tokens.add(next_token)
        page_token = next_token
    raise ImageCopyError("repository inventory limit exceeded")


__all__ = [
    "ImageCopyError",
    "attached_identity",
    "copy_image",
    "compare_repository_images",
    "image_exists",
    "observe_repository_images",
    "observe_common_image_build",
    "compare_repository_build_outputs",
    "resolve_source_digest",
]
