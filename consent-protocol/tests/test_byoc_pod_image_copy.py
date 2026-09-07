"""The BYOC pod runs the person's OWN copy of the image.

The gap this closes survived precisely because nothing asserted the deployed container
image. So the load-bearing test is the simplest one here: a BYOC pod's image is the
user's own Artifact Registry repo, pinned by digest, and hushh's source ref never appears
in it. The rest pin the security-critical seams: the copy runs ONLY under the scoped
consent-plane identity (never an org-admin key), a heal converges to the deployed digest
rather than re-resolving the mutable tag, and the copier is pure REST.
"""

from __future__ import annotations

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

    def get(self, url, headers=None, timeout=None, stream=None):
        return self._answer("GET", url)

    def post(self, url, headers=None, timeout=None):
        return self._answer("POST", url)

    def put(self, url, headers=None, data=None, timeout=None):
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


def test_resolve_source_digest_reads_the_content_digest_header() -> None:
    session = _Session(
        {("GET", "/manifests/v2.1.0"): _Resp(200, headers={"Docker-Content-Digest": DIGEST})}
    )
    assert pod_image_copy.resolve_source_digest(SOURCE, "tok", session) == DIGEST
    # A ref already pinned by digest is returned without a network call.
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
    session = _Session(
        {
            ("GET", f"/manifests/{DIGEST}"): _Resp(
                200,
                headers={"Content-Type": "application/vnd.docker.distribution.manifest.v2+json"},
                content=b"{}",
                json_body=None,
            ),
            ("HEAD", "/blobs/"): _Resp(404),  # dest lacks every blob
            ("GET", "/blobs/"): _Resp(200, chunks=[b"bytes"]),
            ("POST", "/blobs/uploads/"): _Resp(
                202, headers={"Location": f"https://{REGION}-docker.pkg.dev/upload/xyz"}
            ),
            ("PUT", "/upload/xyz"): _Resp(201),
            ("PUT", f"/manifests/{DIGEST}"): _Resp(201),
        }
    )
    # The GET manifest must return the real manifest json as content for parsing.
    import json as _json

    session._routes[("GET", f"/manifests/{DIGEST}")].content = _json.dumps(manifest).encode()

    pod_image_copy.copy_image(SOURCE, f"{DEST}@{DIGEST}", "tok", session)

    methods = [c for c in session.calls]
    # The manifest PUT is LAST -- proof the image is only advertised once its blobs exist.
    put_manifest = max(
        i for i, (m, u) in enumerate(methods) if m == "PUT" and f"/manifests/{DIGEST}" in u
    )
    put_blobs = [i for i, (m, u) in enumerate(methods) if m == "PUT" and "/upload/" in u]
    assert put_blobs and put_manifest > max(put_blobs)


def test_copy_image_requires_a_digest_pinned_destination() -> None:
    with pytest.raises(pod_image_copy.ImageCopyError):
        pod_image_copy.copy_image(SOURCE, f"{DEST}:sometag", "tok", _Session({}))
