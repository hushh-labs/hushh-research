# Deferred Items — Phase 02 Identity Domain

Out-of-scope discoveries logged during execution. Not fixed (scope boundary: only
auto-fix issues directly caused by the current task's changes).

## 02-02

- **Pre-existing `mask_phone` doctest mismatch** (`consent-protocol/hushh_mcp/consent/pii_sanitizer.py`
  `mask_phone` docstring, ~line 85): the doctest expects `'Call +15****4567 ...'` but
  `_mask_phone_digits` produces `'Call 155****4567 ...'`. The `prefix_len = 3 if raw.lstrip().startswith("+")`
  branch is not reached because the `+` is stripped earlier in the matched group, so a
  3-char prefix of the digit string is emitted instead of the `+`-prefixed form. Present
  before plan 02-02 (verified against commit 04e680128). Not run by the pytest suite
  (`tests/test_security.py` asserts `endswith("4567")` only), so CI is green. Fix would be a
  one-line doctest/prefix-logic correction in a dedicated `fix` commit. Untouched by 02-02
  (this plan only added `_mask_text` and identity key routing).
