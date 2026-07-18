# hushh_mcp/integrations/mlx/__init__.py
"""HCT-gated MLX local-inference adapter.

This package provides a consent boundary in front of on-device MLX inference.
It does NOT ship a parallel inference server. The MLX embedder/runtime itself
is planned in Swift under `apps/one-mac/Sources/OneIndexer` (see
`docs/future/one-mac-knowledge-base-app.md`). This module only supplies the
Python-side consent gate so any local caller must present a valid, unexpired,
correctly-scoped, non-revoked Hushh Consent Token (HCT) before an injected
inference callable runs.
"""

from hushh_mcp.integrations.mlx.adapter import (
    ConsentDenied,
    HCTGatedMLXAdapter,
    MLXInferenceResult,
)

__all__ = ["ConsentDenied", "HCTGatedMLXAdapter", "MLXInferenceResult"]
