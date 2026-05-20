# Vault PKM Browser And Data Boundary

Use this reference for vault/PKM changes that touch browser proof, manifests,
upgrade flows, or data-plane classification.

## Vault Browser Boundary

1. The vault key and vault-owner token are memory-only runtime state.
2. Same-session client navigation after unlock is distinct from cold deep-link
   entry that must re-establish unlock state.
3. `page.goto(...)` is not equivalent to Next client navigation for
   vault-protected flows.
4. Browser proof, when required, uses reviewer-mode login, vault unlock through
   maintainer-only secret overlay, and Next client navigation.

## PKM Truth

1. PKM manifests are authoritative when present.
2. `pkm_index` is a discovery cache and may need repair.
3. Keep `manifest_version`, `domain_contract_version`,
   `readable_summary_version`, and whole-PKM `model_version` separate.
4. Vault lock may hide decrypted detail, but must not collapse existing PKM
   into a false empty state.

## Data Plane

1. Migrations touching PKM, vault, or legacy memory tables require runtime DB
   data-plane classification before production readiness.
2. Legacy memory tables may be read for bounded cutover or account cleanup.
3. New canonical writes must target PKM tables only.
4. Route IAM, consent, and verification policy questions to
   `iam-consent-governance` when they become primary.
