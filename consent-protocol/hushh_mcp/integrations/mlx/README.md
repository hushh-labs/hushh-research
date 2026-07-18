# HCT-gated MLX adapter

A small Python consent boundary that must be satisfied before any local MLX
inference callable runs. It reuses the canonical Hushh Consent Token contract in
[`hushh_mcp/consent/token.py`](../../consent/token.py) instead of inventing a
new auth mechanism.

## What this is (and is not)

- **Is:** a deny-by-default gate. Callers pass an HCT string and the declared
  `ConsentScope`; the token is validated via `validate_token` (signature,
  expiry, revocation, scope isolation, optional commercial gate). Only then is
  the injected `inference_fn(prompt, token)` invoked.
- **Is not:** an inference server, an OpenAI/Open WebUI proxy, or a bundled
  model. The MLX runtime for Apple Silicon is a **future-state** plan in Swift
  under `apps/one-mac/Sources/OneIndexer`
  (see [`docs/future/one-mac-knowledge-base-app.md`](../../../../docs/future/one-mac-knowledge-base-app.md)).
  This module deliberately does **not** create a parallel desktop architecture;
  it supplies the reusable Python-side consent gate the on-device path needs.

MLX and OpenClaw remain future-state in this repo. Nothing here should be
presented as shipped on-device inference.

## Usage

```python
from hushh_mcp.constants import ConsentScope
from hushh_mcp.integrations.mlx import HCTGatedMLXAdapter, ConsentDenied

def my_mlx_runner(prompt: str, token) -> str:
    # Inject the real mlx-lm call here on Apple Silicon; kept out of this
    # module so the consent boundary imports and tests on any platform.
    ...

adapter = HCTGatedMLXAdapter(
    my_mlx_runner,
    required_scope=ConsentScope.AGENT_KAI_INFER,
)

try:
    result = adapter.run("summarize my notes", consent_token=hct_string)
    print(result.output)
except ConsentDenied as denied:
    print("denied:", denied.reason)
```

## Why the design is injectable

The real model runner (`mlx-lm`) only loads on Apple Silicon. By injecting the
inference callable, the consent boundary stays importable and fully testable on
Linux/Windows CI, which is where the `tests/integrations/test_mlx_adapter.py`
suite runs (13 tests: valid path, missing/empty/magic-string/forged/tampered
tokens, wrong scope, expiry, revocation, and the commercial gate).

## Tests

```bash
python3 -m pytest consent-protocol/tests/integrations/test_mlx_adapter.py -v
```
