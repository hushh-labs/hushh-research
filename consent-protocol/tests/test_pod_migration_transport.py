"""The hub carries a bundle it cannot open, and proves who it is twice.

Two properties, and the second is the one that would be easy to lose in a later
refactor:

1. **Two tokens, two audiences.** Cloud Run validates the URL-audience token
   before the request arrives; the pod validates a HusshID-audience proof once it
   does. A proof minted for one pod is useless at another.
2. **No decryption path exists here.** The hub verifies by comparing hashes,
   which needs no key. If a future change gives this module a way to read a
   bundle, "hussh does not read this pod" stops being true for the one minute
   that matters most.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_migration_transport as transport
from hushh_mcp.services.pod_migration_transport import (
    PodMigrationTransportError,
    export_from,
    hub_proof_audience,
    import_into,
)


class _Recorder:
    """A requests-shaped stand-in that records what would have been sent."""

    def __init__(self, status=200, body=None):
        self.status = status
        self.body = body if body is not None else {"headSha": "abc", "recordCount": 2}
        self.calls: list[dict] = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(
            {"url": url, "json": json, "headers": dict(headers or {}), "timeout": timeout}
        )
        recorder = self

        class _Response:
            status_code = recorder.status

            @staticmethod
            def json():
                return recorder.body

        return _Response()


@pytest.fixture
def minted(monkeypatch):
    """Both tokens mint successfully, recording which audiences were asked for."""
    asked: list[str] = []

    def _mint(audience: str):
        asked.append(audience)
        return f"token-for::{audience}"

    monkeypatch.setattr(transport, "_mint_id_token", _mint)
    return asked


# --------------------------------------------------------------------------- #
# Two tokens, two audiences
# --------------------------------------------------------------------------- #


def test_the_proof_is_bound_to_the_agent_and_the_invoke_token_to_the_service(minted):
    session = _Recorder()

    export_from(
        pod_url="https://one-pod-abc.run.app",
        hushh_id="ha1_abc",
        recipient_public_key="key",
        recipient_key_id="kid",
        session=session,
    )

    headers = session.calls[0]["headers"]
    # Cloud Run's lock: audience is the service URL.
    assert headers["Authorization"] == "Bearer token-for::https://one-pod-abc.run.app"
    # The pod's lock: audience names THIS agent, so the proof cannot be replayed
    # at another pod by a caller who legitimately holds one.
    assert headers["X-Hussh-Hub-Proof"] == "Bearer token-for::hussh-pod-migration:ha1_abc"
    assert minted == ["https://one-pod-abc.run.app", "hussh-pod-migration:ha1_abc"]


def test_the_two_ends_agree_on_the_audience_by_construction():
    """The hub imports the pod's own definition rather than re-deriving it.

    Two copies of this string would agree by coincidence, and a one-character
    drift would surface as a 403 with no obvious cause.
    """
    from api.routes.one.pod_migration import hub_proof_audience as pod_side

    assert hub_proof_audience("ha1_abc") == pod_side("ha1_abc")


def test_a_missing_identity_refuses_rather_than_sending_half_a_request(monkeypatch):
    """A call missing the proof would be rejected by the pod as a 403, which
    reads like a misconfigured allowlist and sends an operator looking in the
    wrong project entirely."""
    monkeypatch.setattr(transport, "_mint_id_token", lambda _audience: None)
    session = _Recorder()

    with pytest.raises(PodMigrationTransportError) as excinfo:
        export_from(
            pod_url="https://one-pod-abc.run.app",
            hushh_id="ha1_abc",
            recipient_public_key="key",
            recipient_key_id="kid",
            session=session,
        )

    assert excinfo.value.code == "HUB_IDENTITY_UNAVAILABLE"
    assert session.calls == [], "a request went out without both tokens"


def test_only_the_proof_is_missing_still_refuses(monkeypatch):
    """Half-authenticated is not a degraded mode, it is a refusal."""
    monkeypatch.setattr(
        transport,
        "_mint_id_token",
        lambda audience: None if audience.startswith("hussh-pod-migration") else "invoke",
    )
    session = _Recorder()

    with pytest.raises(PodMigrationTransportError):
        import_into(
            pod_url="https://one-pod-abc.run.app",
            hushh_id="ha1_abc",
            bundle={"ciphertext": "..."},
            session=session,
        )
    assert session.calls == []


# --------------------------------------------------------------------------- #
# The pod's own words survive
# --------------------------------------------------------------------------- #


def test_a_pod_refusal_reaches_the_caller_verbatim(minted):
    """The pod knows why it refused -- "already has 4 records", "addressed to
    pod key X". Replacing that with a generic failure throws away the only
    useful sentence in the chain."""
    session = _Recorder(
        status=409, body={"detail": "this pod already has 4 record(s); refusing to import"}
    )

    with pytest.raises(PodMigrationTransportError) as excinfo:
        import_into(
            pod_url="https://one-pod-abc.run.app",
            hushh_id="ha1_abc",
            bundle={"ciphertext": "..."},
            session=session,
        )

    assert excinfo.value.code == "POD_REFUSED_409"
    assert "already has 4 record" in excinfo.value.message


def test_an_unreachable_pod_is_a_typed_refusal_not_a_crash(minted):
    class _Dead:
        @staticmethod
        def post(*_args, **_kwargs):
            raise ConnectionError("no route to host")

    with pytest.raises(PodMigrationTransportError) as excinfo:
        export_from(
            pod_url="https://one-pod-abc.run.app",
            hushh_id="ha1_abc",
            recipient_public_key="key",
            recipient_key_id="kid",
            session=_Dead(),
        )

    assert excinfo.value.code == "POD_UNREACHABLE"


# --------------------------------------------------------------------------- #
# The hub cannot read what it carries
# --------------------------------------------------------------------------- #


def test_this_module_has_no_decryption_path():
    """A structural assertion, not a behavioural one.

    The hub's verification is a hash comparison, which needs no key. If this
    module ever grows a decryption import, the migration stops being the thing
    it claims to be -- and the review that lets it through will not be looking
    for it, so the test looks instead.
    """
    import ast
    from pathlib import Path

    tree = ast.parse(Path(transport.__file__).read_text(encoding="utf-8"))

    # Parsed rather than grepped, deliberately. A text search matches this
    # module's own prose explaining why it cannot decrypt, which would make the
    # guard fail for saying the right thing -- and the obvious fix (delete the
    # explanation) is worse than no guard at all.
    imported: set[str] = set()
    called: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Call):
            func = node.func
            name = getattr(func, "id", None) or getattr(func, "attr", None)
            if name:
                called.add(name)

    forbidden_imports = {"cryptography", "open_bundle", "pod_migration_bundle"}
    leaked = {n for n in imported if any(f in n for f in forbidden_imports)}
    assert not leaked, (
        f"the hub's migration transport imports {sorted(leaked)} -- it must carry "
        "the bundle without any means of opening it"
    )

    forbidden_calls = {"decrypt", "open_bundle", "unseal", "resolve_pod_log_key"}
    assert not (called & forbidden_calls), (
        f"the hub's migration transport calls {sorted(called & forbidden_calls)}"
    )


def test_the_import_timeout_exceeds_the_export_timeout():
    """The destination replays every record through the ordinary append path,
    one compare-and-swap at a time -- the same slowness that makes the resulting
    head trustworthy. A shorter budget there would time out on exactly the
    largest, most valuable histories."""
    assert transport._IMPORT_TIMEOUT_SECONDS > transport._EXPORT_TIMEOUT_SECONDS


# --------------------------------------------------------------------------- #
# The operator seam: an injected minter drives the tokens, so a shell can call it
# --------------------------------------------------------------------------- #


def test_an_injected_token_minter_is_used_instead_of_adc():
    """The hub calls this in Cloud Run with a metadata server; an operator driving
    the rehearsal from a shell has none, so it injects a minter backed by its
    service-account key. Both audiences must come from the injected minter, not
    from ADC."""
    session = _Recorder()
    asked: list[str] = []

    def _minter(audience: str) -> str:
        asked.append(audience)
        return f"op::{audience}"

    export_from(
        pod_url="https://one-pod-abc.run.app",
        hushh_id="ha1_abc",
        recipient_public_key="key",
        recipient_key_id="kid",
        session=session,
        token_minter=_minter,
    )

    headers = session.calls[0]["headers"]
    assert headers["Authorization"] == "Bearer op::https://one-pod-abc.run.app"
    assert headers["X-Hussh-Hub-Proof"] == "Bearer op::hussh-pod-migration:ha1_abc"
    # ADC was never consulted -- both tokens came from the injected minter.
    assert asked == ["https://one-pod-abc.run.app", "hussh-pod-migration:ha1_abc"]


def test_import_into_also_honours_the_injected_minter():
    session = _Recorder(body={"headSha": "abc", "recordCount": 1})

    def _minter(audience: str) -> str:
        return f"op::{audience}"

    import_into(
        pod_url="https://one-pod-dst.run.app",
        hushh_id="ha1_abc",
        bundle={"ciphertext": "..."},
        session=session,
        token_minter=_minter,
    )
    headers = session.calls[0]["headers"]
    assert headers["Authorization"].startswith("Bearer op::https://one-pod-dst.run.app")


def test_a_minter_that_returns_none_refuses_rather_than_sending_half_a_request():
    """Same fail-closed rule as ADC: a missing token is a refusal, not a
    degraded call, so an operator sees a clear error rather than a pod 403."""
    from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError

    session = _Recorder()
    with pytest.raises(PodMigrationTransportError) as excinfo:
        export_from(
            pod_url="https://one-pod-abc.run.app",
            hushh_id="ha1_abc",
            recipient_public_key="key",
            recipient_key_id="kid",
            session=session,
            token_minter=lambda _audience: None,
        )
    assert excinfo.value.code == "HUB_IDENTITY_UNAVAILABLE"
    assert session.calls == []
