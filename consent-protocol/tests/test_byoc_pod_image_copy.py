"""The BYOC pod runs the person's OWN copy of the image.

The gap this closes survived precisely because nothing asserted the deployed container
image. So the load-bearing test is the simplest one here: a BYOC pod's image is the
user's own Artifact Registry repo, pinned by digest, and hushh's source ref never appears
in it. The rest pin the security-critical seams: the copy runs ONLY under the scoped
consent-plane identity (never an org-admin key), a heal converges to the deployed digest
rather than re-resolving the mutable tag, and the copier is pure REST.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from hushh_mcp.services import pod_image_copy
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_gcp_backend import UserGcpBackend, _digest_from_service

USER_PROJECT = "someones-own-project"
REGION = "us-central1"
INVOKER = "consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
SOURCE = "gcr.io/hushh-pda-dev/consent-protocol-pod:v2.1.0"
DIGEST = "sha256:" + "a" * 64
DEST = f"{REGION}-docker.pkg.dev/{USER_PROJECT}/one-pod/consent-protocol-pod"


def _spec() -> PodSpec:
    return PodSpec(hushh_id="ha1_abc", phone_e164_hash="p", pod_pubkey="k")


def _backend(**kw) -> UserGcpBackend:
    return UserGcpBackend(
        user_project=USER_PROJECT,
        user_region=REGION,
        image=SOURCE,
        hushh_invoker_sa=INVOKER,
        bootstrap_sa=f"one-bootstrap@{USER_PROJECT}.iam.gserviceaccount.com",
        live=False,
        **kw,
    )


def _image_of(cfg: dict) -> str:
    return cfg["spec"]["template"]["spec"]["containers"][0]["image"]


# --- F: the render rewrite (the highest-value assertion) ---------------------------


def test_the_byoc_pod_image_is_the_users_own_repo_pinned_by_digest() -> None:
    image = _image_of(_backend().render_deploy_config(_spec(), image_digest=DIGEST))
    assert image == f"{DEST}@{DIGEST}"
    # hushh's private source ref must NEVER be what a sovereign pod pulls.
    assert "gcr.io/hushh-pda-dev" not in image


def test_the_dev_fallback_is_a_labelled_tag_in_the_users_repo_not_hushhs() -> None:
    # No digest yet (plan / dry render): a transitional tag ref, still the user's repo.
    image = _image_of(_backend().render_deploy_config(_spec()))
    assert image == f"{DEST}:v2.1.0"
    assert "gcr.io/hushh-pda-dev" not in image


def test_the_metadata_and_plan_do_not_claim_the_pod_runs_hushhs_image() -> None:
    plan = _backend().render_bootstrap_plan(_spec())
    svc = next(r for r in plan["resources"] if r["type"] == "cloud_run_service")
    assert svc["image"].startswith(f"{REGION}-docker.pkg.dev/{USER_PROJECT}/one-pod/")
    assert svc["source_image"] == SOURCE
    # And the consent artifact advertises both new grants the applier makes.
    roles = {b["role"] for b in plan["iam"]}
    assert "roles/artifactregistry.writer" in roles
    assert "roles/artifactregistry.reader" in roles


# --- F2: a heal reads the deployed digest, never re-resolves the tag ----------------


def test_digest_from_service_reads_the_deployed_pin() -> None:
    def svc(image: str) -> dict:
        return {"spec": {"template": {"spec": {"containers": [{"image": image}]}}}}

    assert _digest_from_service(svc(f"{DEST}@{DIGEST}")) == DIGEST
    assert _digest_from_service(svc(f"{DEST}:v2.1.0")) is None
    assert _digest_from_service(None) is None
    assert _digest_from_service({}) is None


# --- F3 + F2: _ensure_pod_image identity guard, idempotency, heal convergence -------


def _patch_copy(monkeypatch, *, email: str, present: bool, resolved: str = DIGEST):
    seen: dict = {"resolved": False, "copied_to": None}
    monkeypatch.setattr(pod_image_copy, "attached_identity", lambda session=None: ("tok", email))

    def _resolve(ref, token, session=None):
        seen["resolved"] = True
        return resolved

    def _copy(src, dst, token, session=None):
        seen["copied_to"] = dst

    monkeypatch.setattr(pod_image_copy, "resolve_source_digest", _resolve)
    monkeypatch.setattr(pod_image_copy, "image_exists", lambda ref, token, session=None: present)
    monkeypatch.setattr(pod_image_copy, "copy_image", _copy)
    return seen


def test_ensure_pod_image_refuses_an_identity_that_is_not_the_granted_writer(monkeypatch) -> None:
    # The metadata server resolves to the org-admin account rather than the granted
    # consent-plane SA -- the F3 finding. The copy must REFUSE, not push under it.
    _patch_copy(monkeypatch, email="org-admin@hushh.iam.gserviceaccount.com", present=False)
    with pytest.raises(RuntimeError, match="refusing the pod-image copy"):
        _backend()._ensure_pod_image(_spec())


def test_ensure_pod_image_copies_under_the_granted_identity(monkeypatch) -> None:
    seen = _patch_copy(monkeypatch, email=INVOKER, present=False)
    digest = _backend()._ensure_pod_image(_spec())
    assert digest == DIGEST
    assert seen["copied_to"] == f"{DEST}@{DIGEST}"


def test_ensure_pod_image_is_a_no_op_when_the_digest_is_already_present(monkeypatch) -> None:
    seen = _patch_copy(monkeypatch, email=INVOKER, present=True)
    assert _backend()._ensure_pod_image(_spec()) == DIGEST
    assert seen["copied_to"] is None  # present -> nothing pushed


def test_a_heal_converges_to_the_recorded_digest_without_re_resolving_the_tag(monkeypatch) -> None:
    recorded = "sha256:" + "c" * 64
    seen = _patch_copy(monkeypatch, email=INVOKER, present=True, resolved="sha256:" + "b" * 64)
    digest = _backend()._ensure_pod_image(_spec(), recorded_digest=recorded)
    assert digest == recorded  # the deployed digest, not a fresh tag resolution
    assert seen["resolved"] is False  # the mutable source tag was NOT re-read on heal


# --- the copier itself: pure REST over a fake registry -----------------------------


class _Resp:
    def __init__(self, status: int, *, headers=None, content=b"", json_body=None, chunks=None):
        self.status_code = status
        self.headers = headers or {}
        self.content = content
        self._json = json_body
        self._chunks = chunks or []

    def json(self):
        return self._json

    def iter_content(self, chunk_size=0):
        return iter(self._chunks)


class _Session:
    """Routes by (METHOD, url-fragment). Records calls for assertion."""

    def __init__(self, routes: dict):
        self._routes = routes
        self.calls: list[tuple[str, str]] = []

    def _answer(self, method: str, url: str) -> _Resp:
        self.calls.append((method, url))
        for (m, frag), resp in self._routes.items():
            if m == method and frag in url:
                return resp
        return _Resp(404)

    def get(self, url, headers=None, timeout=None, stream=None, allow_redirects=True):
        return self._answer("GET", url)

    def post(self, url, headers=None, timeout=None, allow_redirects=True):
        return self._answer("POST", url)

    def put(self, url, headers=None, data=None, timeout=None, allow_redirects=True):
        return self._answer("PUT", url)

    def request(self, method, url, headers=None, timeout=None):
        return self._answer(method, url)


def test_attached_identity_prefers_the_metadata_server() -> None:
    # On GCP the email endpoint returns text; the token endpoint returns json.
    class _S:
        def get(self, url, headers=None, timeout=None):
            if url.endswith("/email"):
                r = _Resp(200)
                r.text = INVOKER
                return r
            return _Resp(200, json_body={"access_token": "tok-123"})

    token, email = pod_image_copy.attached_identity(_S())
    assert email == INVOKER and token == "tok-123"


def test_attached_identity_falls_back_to_adc_off_gcp(monkeypatch) -> None:
    # No metadata server (localhost/CI): the resolver falls back to ADC, which the
    # operator has pointed at the consent-plane SA. The caller still asserts the email.
    class _NoMetadata:
        def get(self, url, headers=None, timeout=None):
            raise OSError("metadata host unreachable")

    monkeypatch.setattr(pod_image_copy, "_acting_identity_via_adc", lambda: ("adc-tok", INVOKER))
    assert pod_image_copy.attached_identity(_NoMetadata()) == ("adc-tok", INVOKER)


def test_attached_identity_raises_when_neither_source_resolves(monkeypatch) -> None:
    class _NoMetadata:
        def get(self, url, headers=None, timeout=None):
            raise OSError("no metadata")

    monkeypatch.setattr(pod_image_copy, "_acting_identity_via_adc", lambda: ("", ""))
    with pytest.raises(pod_image_copy.ImageCopyError):
        pod_image_copy.attached_identity(_NoMetadata())


def test_resolve_source_digest_verifies_the_content_digest_header() -> None:
    content = b'{"schemaVersion":2}'
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    session = _Session(
        {
            ("GET", "/manifests/v2.1.0"): _Resp(
                200, headers={"Docker-Content-Digest": digest}, content=content
            )
        }
    )
    assert pod_image_copy.resolve_source_digest(SOURCE, "tok", session) == digest
    assert pod_image_copy.resolve_source_digest(f"{DEST}@{DIGEST}", "tok", _Session({})) == DIGEST


def test_image_exists_is_a_head_that_reports_present_vs_absent() -> None:
    present = _Session({("HEAD", "/manifests/"): _Resp(200)})
    absent = _Session({("HEAD", "/manifests/"): _Resp(404)})
    assert pod_image_copy.image_exists(f"{DEST}@{DIGEST}", "tok", present) is True
    assert pod_image_copy.image_exists(f"{DEST}@{DIGEST}", "tok", absent) is False


def test_copy_image_copies_config_and_layers_then_the_manifest_last() -> None:
    config_digest = "sha256:" + "1" * 64
    layer_digest = "sha256:" + "2" * 64
    manifest = {
        "config": {"digest": config_digest},
        "layers": [{"digest": layer_digest}],
    }
    content = json.dumps(manifest).encode()
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    session = _Session(
        {
            ("GET", f"/manifests/{digest}"): _Resp(
                200,
                headers={"Content-Type": "application/vnd.docker.distribution.manifest.v2+json"},
                content=content,
                json_body=None,
            ),
            ("HEAD", "/blobs/"): _Resp(404),  # dest lacks every blob
            ("GET", "/blobs/"): _Resp(200, chunks=[b"bytes"]),
            ("POST", "/blobs/uploads/"): _Resp(
                202, headers={"Location": f"https://{REGION}-docker.pkg.dev/upload/xyz"}
            ),
            ("PUT", "/upload/xyz"): _Resp(201),
            ("PUT", f"/manifests/{digest}"): _Resp(201),
        }
    )
    pod_image_copy.copy_image(SOURCE, f"{DEST}@{digest}", "tok", session)

    methods = [c for c in session.calls]
    # The manifest PUT is LAST -- proof the image is only advertised once its blobs exist.
    put_manifest = max(
        i for i, (m, u) in enumerate(methods) if m == "PUT" and f"/manifests/{digest}" in u
    )
    put_blobs = [i for i, (m, u) in enumerate(methods) if m == "PUT" and "/upload/" in u]
    assert put_blobs and put_manifest > max(put_blobs)


def test_copy_image_requires_a_digest_pinned_destination() -> None:
    with pytest.raises(pod_image_copy.ImageCopyError):
        pod_image_copy.copy_image(SOURCE, f"{DEST}:sometag", "tok", _Session({}))


@pytest.mark.parametrize(
    "location",
    [
        "https://foreign.example/upload",
        "http://us-central1-docker.pkg.dev/upload",
        "//foreign.example/upload",
        "https://user@us-central1-docker.pkg.dev/upload",
        "https://us-central1-docker.pkg.dev/upload#fragment",
        " https://us-central1-docker.pkg.dev/upload",
        "/upload/xyz",
        "https://us-central1-docker.pkg.dev/upload/xyz?state=opaque",
    ],
)
def test_blob_upload_keeps_credentials_at_destination(location):
    from unittest.mock import Mock

    session = Mock()
    session.request.return_value = _Resp(404)
    session.get.return_value = _Resp(200, chunks=[b"synthetic-layer"])
    session.post.return_value = _Resp(202, headers={"Location": location})
    session.put.return_value = _Resp(201)
    accepted = location in {
        "/upload/xyz",
        "https://us-central1-docker.pkg.dev/upload/xyz?state=opaque",
    }
    args = (
        ("source.example", "image"),
        ("us-central1-docker.pkg.dev", "project/repo/image"),
        DIGEST,
        "synthetic-token",
        session,
    )
    if accepted:
        pod_image_copy._copy_blob(*args)
        url = session.put.call_args.args[0]
        assert url.startswith("https://us-central1-docker.pkg.dev/upload/xyz?")
        assert url.endswith("digest=" + DIGEST)
        if "state=opaque" in location:
            assert "state=opaque&" in url
        assert session.put.call_args.kwargs["allow_redirects"] is False
    else:
        with pytest.raises(pod_image_copy.ImageCopyError, match="outside destination authority"):
            pod_image_copy._copy_blob(*args)
        session.put.assert_not_called()
    assert session.post.call_args.kwargs["allow_redirects"] is False


@pytest.mark.parametrize("operation", ["resolve", "copy"])
def test_manifest_digest_mismatch_refuses_before_destination_mutation(operation):
    session = _Session(
        {
            ("GET", "/manifests/"): _Resp(
                200, headers={"Docker-Content-Digest": DIGEST}, content=b"corrupted-manifest"
            )
        }
    )
    with pytest.raises(pod_image_copy.ImageCopyError, match="content digest unverified"):
        if operation == "resolve":
            pod_image_copy.resolve_source_digest(SOURCE, "tok", session)
        else:
            pod_image_copy.copy_image(SOURCE, f"{DEST}@{DIGEST}", "tok", session)
    assert all(method == "GET" for method, _ in session.calls)


@pytest.mark.parametrize("corrupt_child", [False, True])
def test_multiarch_copy_verifies_child_before_publishing_index(corrupt_child):
    child = b'{"schemaVersion":2,"layers":[]}'
    child_digest = "sha256:" + hashlib.sha256(child).hexdigest()
    index = json.dumps({"manifests": [{"digest": child_digest}]}).encode()
    index_digest = "sha256:" + hashlib.sha256(index).hexdigest()
    session = _Session(
        {
            ("GET", f"/manifests/{index_digest}"): _Resp(
                200,
                content=index,
                headers={"Content-Type": "application/vnd.oci.image.index.v1+json"},
            ),
            ("GET", f"/manifests/{child_digest}"): _Resp(
                200,
                content=b"corrupted" if corrupt_child else child,
                headers={"Content-Type": "application/vnd.oci.image.manifest.v1+json"},
            ),
            ("PUT", "/manifests/"): _Resp(201),
        }
    )
    if corrupt_child:
        with pytest.raises(pod_image_copy.ImageCopyError, match="content digest unverified"):
            pod_image_copy.copy_image(SOURCE, f"{DEST}@{index_digest}", "tok", session)
        assert all(method == "GET" for method, _ in session.calls)
    else:
        pod_image_copy.copy_image(SOURCE, f"{DEST}@{index_digest}", "tok", session)
        writes = [url.rsplit("/", 1)[-1] for method, url in session.calls if method == "PUT"]
        assert writes == [child_digest, index_digest]


@pytest.mark.parametrize(
    "case",
    [
        "success",
        "denied",
        "replaced",
        "repeated",
        "foreign",
        "duplicate",
        "malformed",
        "error_envelope",
        "encoded",
    ],
)
def test_repository_inventory_is_scoped_paginated_and_never_cleanup_authority(case):
    identity = {
        "name": f"projects/{USER_PROJECT}/locations/{REGION}/repositories/one-pod",
        "format": "DOCKER",
        "createTime": "2026-09-08T00:00:00Z",
    }
    image = {
        "name": identity["name"] + "/dockerImages/consent-protocol-pod@" + DIGEST,
        "uri": DEST + "@" + DIGEST,
        "tags": ["not-retained"],
    }
    calls = []
    identity_reads = 0

    class Session:
        def get(self, url, **kwargs):
            nonlocal identity_reads
            calls.append((url, kwargs))
            assert kwargs["allow_redirects"] is False
            if not url.endswith("/dockerImages"):
                identity_reads += 1
                return _Resp(
                    200,
                    json_body={
                        **identity,
                        "createTime": "2026-09-09T00:00:00Z"
                        if case == "replaced" and identity_reads == 2
                        else identity["createTime"],
                    },
                )
            if case == "denied":
                return _Resp(403)
            if case == "error_envelope":
                return _Resp(200, json_body={"error": {"message": "synthetic"}})
            if not kwargs["params"]["pageToken"]:
                return _Resp(200, json_body={"dockerImages": [], "nextPageToken": "next"})
            entry = {**image, "uri": "foreign@" + DIGEST} if case == "foreign" else image
            if case == "encoded":
                entry = {**image, "name": image["name"].replace("@", "%40")}
            return _Resp(
                200,
                json_body={
                    "dockerImages": None
                    if case == "malformed"
                    else [entry, entry]
                    if case == "duplicate"
                    else [entry],
                    "nextPageToken": "next" if case == "repeated" else "",
                },
            )

    def observe():
        return pod_image_copy.observe_repository_images(
            project=USER_PROJECT,
            region=REGION,
            expected_identity=identity,
            token="synthetic",  # noqa: S106 -- scripted session, no usable credential
            session=Session(),
        )

    if case in {"success", "encoded"}:
        result = observe()
        assert result["classification"] == "unresolved"
        assert result["paginationComplete"] is True
        assert result["images"] == [{key: image[key] for key in ("name", "uri")}]
        assert identity_reads == 2
    else:
        with pytest.raises(pod_image_copy.ImageCopyError):
            observe()
    assert all(
        url.startswith("https://artifactregistry.googleapis.com/v1/" + identity["name"])
        for url, _ in calls
    )


@pytest.mark.parametrize(
    "case",
    [
        "match",
        "missing_source",
        "corrupt_child",
        "other_package",
        "foreign_destination",
        "foreign_source",
        "redirect",
    ],
)
def test_repository_source_comparison_verifies_both_graphs_with_separate_credentials(case):
    leaf = b'{"schemaVersion":2,"layers":[]}'
    leaf_digest = "sha256:" + hashlib.sha256(leaf).hexdigest()
    root = json.dumps({"manifests": [{"digest": leaf_digest}]}).encode()
    root_digest = "sha256:" + hashlib.sha256(root).hexdigest()
    uri = f"{DEST}@{root_digest}"
    if case == "other_package":
        uri = uri.replace("consent-protocol-pod@", "unrelated-package@")
    if case == "foreign_destination":
        uri = "foreign.example/package@" + root_digest
    inventory = {
        "repositoryIdentity": {
            "name": f"projects/{USER_PROJECT}/locations/{REGION}/repositories/one-pod"
        },
        "paginationComplete": True,
        "images": [{"uri": uri}],
    }
    calls = []

    class Session:
        def get(self, url, **kwargs):
            calls.append(url)
            source = url.startswith("https://gcr.io/")
            assert kwargs["allow_redirects"] is False
            if case == "redirect":
                return _Resp(302, headers={"Location": "https://foreign.example/manifest"})
            assert kwargs["headers"]["Authorization"] == "Bearer " + (
                "source-token" if source else "destination-token"
            )
            assert "/manifests/v2.1.0" not in url
            if source and case == "missing_source":
                return _Resp(404)
            is_root = url.endswith(root_digest)
            content = root if is_root else leaf
            if not source and not is_root and case == "corrupt_child":
                content = b"corrupted"
            return _Resp(
                200,
                content=content,
                headers={
                    "Content-Type": "application/vnd.oci.image.index.v1+json"
                    if is_root
                    else "application/vnd.oci.image.manifest.v1+json"
                },
            )

    def compare():
        return pod_image_copy.compare_repository_images(
            inventory=inventory,
            source_ref="foreign.example/private:tag" if case == "foreign_source" else SOURCE,
            source_token="source-token",  # noqa: S106 -- scripted provider credential
            destination_token="destination-token",  # noqa: S106 -- scripted provider credential
            session=Session(),
        )

    if case in {"foreign_destination", "foreign_source"}:
        with pytest.raises(pod_image_copy.ImageCopyError):
            compare()
        assert not calls
    else:
        result = compare()
        assert result["classification"] == "unresolved"
        assert result["blobContentsChecked"] is False
        assert result["images"][0]["manifestEquivalent"] is (case == "match")
        if case == "match":
            assert len(calls) == 4
            assert result["images"][0]["manifestGraph"] == sorted(
                [
                    {"digest": root_digest, "children": [leaf_digest]},
                    {"digest": leaf_digest, "children": []},
                ],
                key=lambda node: node["digest"],
            )
        if case == "other_package":
            assert not calls
