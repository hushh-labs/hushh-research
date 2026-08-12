"""Adding a cloud provider must not require editing the common pod architecture.

This is the falsifiable form of the deployment abstraction boundary
(docs/reference/architecture/deployment-abstraction-boundary.md). The boundary is
worth exactly as much as the thing that detects a breach, and every breach of it looks
locally reasonable at the moment it is made -- one `if backend == "aws"` in the
orchestrator is a two-line change that solves a real problem and permanently converts a
pluggable seam into a switch statement with three arms and then five.

THE LAYERS

  Layer 1  the common pod architecture -- the orchestrator and the registry. Knows
           about people, consent, lifecycle states. Knows NOTHING about clouds.
  Layer 2  ComputeBackend -- one adapter per provider, per-person instance lifecycle.
  Layer 3  the substrate provisioner -- per-tenant infrastructure, applied once.

`compute_backend.py` is deliberately NOT policed for provider names: it is the module
that DEFINES the backend identifiers, so naming them there is its job. The test is
about the orchestrator and the registry, which must be able to run a fleet across
providers they cannot name.

WHY THIS IS NOT A STYLE TEST

It has already been proven possible: Anypoint is a Mule application on CloudHub 2.0 --
not a container, not GCP -- and it satisfies the same five-method protocol as Cloud
Run. So a Layer 1 file that needs to know a provider's name is not paying an
unavoidable cost; it is describing a design defect that has a known-good alternative.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]

# The common layer. These files orchestrate a fleet they must not be able to name.
_LAYER_ONE = (
    "hushh_mcp/services/personal_agent_provisioning_service.py",
    "hushh_mcp/services/personal_agent_registry_repo.py",
    "hushh_mcp/services/personal_agent_reconcile_worker.py",
)

# Provider-specific vocabulary. Deliberately the PRODUCT names rather than generic
# words like "bucket" or "region", which are legitimate neutral infrastructure nouns.
_PROVIDER_TERMS = (
    "cloud run",
    "cloudrun",
    "knative",
    "gcp",
    "cloudhub",
    "anypoint",
    "mulesoft",
    "fargate",
    "app runner",
    "apprunner",
    "lambda",
    "container apps",
    "azure",
    "aws",
)


def _code_without_comments_or_docstrings(source: str) -> str:
    """Executable text only.

    Comments and docstrings in Layer 1 legitimately DISCUSS providers -- explaining
    that a backend may be inert in plan mode, or why a handle's fields are dropped, is
    exactly the context a reader needs. What must not exist is a provider name the
    RUNTIME depends on. Stripping prose is what keeps this test about behaviour rather
    than about how much a file is allowed to explain itself.
    """
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
            if isinstance(first.value.value, str):
                for line in range(first.lineno, (first.end_lineno or first.lineno) + 1):
                    docstrings.add(line)

    kept: list[str] = []
    for number, line in enumerate(source.splitlines(), start=1):
        if number in docstrings:
            continue
        kept.append(line.split("#", 1)[0])
    return "\n".join(kept).lower()


@pytest.mark.parametrize("rel", _LAYER_ONE)
def test_the_common_layer_cannot_name_a_cloud_provider(rel: str) -> None:
    code = _code_without_comments_or_docstrings((_BACKEND / rel).read_text(encoding="utf-8"))
    found = sorted({term for term in _PROVIDER_TERMS if term in code})
    assert not found, (
        f"BOUNDARY BREACH -- {rel} names {found} in executable code.\n\n"
        "The common pod architecture must orchestrate a fleet it cannot name. A "
        "provider name here means the next provider is a new branch in shared code "
        "rather than a new adapter, and that cost compounds with every provider "
        "after it.\n\n"
        "The fix is almost always to move the decision behind ComputeBackend, or to "
        "promote the fact the orchestrator needs onto a TYPED field of BackendHandle "
        "so it can be read without knowing who produced it."
    )


def test_every_backend_in_the_parity_matrix_is_covered_by_an_extractor() -> None:
    """A provider added without a reduction is a provider nobody checks.

    Parity is asserted by reducing each backend's own artifact shape to a shared set
    of facts. That design is what lets platforms render genuinely different documents
    -- knative Service vs AMC descriptor -- without a lowest-common-denominator schema.

    Note what is NOT asserted: one extractor per backend. `gcp` and `user_gcp` both
    render knative Services, so they SHARE `_extract_knative`, and that is correct --
    the reduction belongs to the artifact SHAPE, not to the backend. An earlier
    version of this test demanded a distinct extractor each and failed on exactly that
    legitimate sharing, which would have pushed someone toward duplicating a correct
    function to satisfy a test. The real invariant is coverage plus more than one
    shape actually being exercised.
    """
    source = (_BACKEND / "tests/test_compute_backend_parity.py").read_text(encoding="utf-8")
    matrix = re.search(r"_BACKENDS[^=]*=\s*\[(.*?)\n\]", source, re.S)
    assert matrix, "the parity matrix is gone; nothing asserts cross-provider capability"
    entries = [line for line in matrix.group(1).splitlines() if line.strip().startswith("(")]
    assert len(entries) >= 2, "parity across one backend is not parity"
    for entry in entries:
        assert "_extract_" in entry, (
            f"a backend in the parity matrix has no reduction: {entry.strip()}. Its "
            "rendered artifact is never checked for the capabilities a pod needs to boot."
        )
    shapes = set(re.findall(r"_extract_(\w+)", matrix.group(1)))
    assert len(shapes) >= 2, (
        f"only one artifact shape ({shapes}) is exercised. Cross-provider parity that "
        "never crosses a shape boundary proves nothing about portability."
    )


def test_the_backend_protocol_stays_small() -> None:
    """Every method is a tax on every future provider.

    Five methods is the current contract and it has carried two genuinely different
    execution models. Growth here is not neutral: a sixth method must be implemented
    by AWS, Azure, Anypoint and both GCP backends, and the pressure to add one is
    always a single provider's need. Add it to the ADAPTER, or put the fact on
    BackendHandle -- widening the protocol is the last resort, not the first.
    """
    source = (_BACKEND / "hushh_mcp/services/compute_backend.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    protocol = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef) and node.name == "ComputeBackend"
    )
    methods = [
        n.name
        for n in protocol.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith("_")
    ]
    assert sorted(methods) == sorted(
        ["provision", "deprovision", "get", "render_deploy_config", "health"]
    ), (
        f"the ComputeBackend protocol changed to {sorted(methods)}. Every provider "
        "must implement all of it, so this is a deliberate architectural decision -- "
        "update the boundary ADR in the same change, or find a way to carry the fact "
        "on BackendHandle instead."
    )
