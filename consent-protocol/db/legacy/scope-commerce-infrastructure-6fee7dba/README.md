# Frozen infrastructure migration lineage

This archive preserves the exact release manifest and migration bytes from `6fee7dba6ee6d5354759434b6801c274980c8599` before synchronization with main `86b5d11f653f9877ff58cf6d15a18a494507edeb`. Main registered Business Profile at 306; the unreleased branch suffix moves to 312–317. The numeric release authority rejects duplicate IDs.

Shared Dev readback at 2026-10-11T14:10:29Z shows 59 historical receipts, no baseline, and no accepted 306–317 receipts. The retained UAT/production readback from 2026-10-10 shows no accepted branch suffix; refresh environment evidence before any deployment there. No database receipt or existing financial record is rewritten. The earlier `scope-commerce-infrastructure-f0517d5f` archive remains unchanged.

| Frozen filename | Active filename | SQL SHA-256 |
|---|---|---|
| `306_vault_environment_enrollment.sql` | `312_vault_environment_enrollment.sql` | `9f1fe45a135fe21b591288e6101bd8731d853a51f856d9bc96c4267d617785aa` |
| `307_consumer_scope_commerce.sql` | `313_consumer_scope_commerce.sql` | `153b30ae338b61fac9e9db361dd2eb5b6c5e73bef53a11c7ede3e917e980cb05` |
| `308_one_shared_hosting_choice.sql` | `314_one_shared_hosting_choice.sql` | `1c92b4957ba8b8684e09c5e0d36fca1c6635f94a7e51184024c5e21bbac8e1d6` |
| `309_public_profile_bridge.sql` | `315_public_profile_bridge.sql` | `495609d6e515da292a5ec52915ceb7ec090b474a9b28edfcfa6a3c4230120db4` |
| `310_one_placement_reader_foundation.sql` | `316_one_placement_reader_foundation.sql` | `aad7ce3d059077339eaa5630bf7a916f7fb4460336142c31aac967a00e6f3d6b` |
| `311_one_legacy_shared_continuity.sql` | `317_one_legacy_shared_continuity.sql` | `5ef3f5d680e8c9ed07ca96d967be09eea2b6d33410cb0162574ee00d0f26f5f8` |

Rollback files retain their corresponding original bytes:

- `rollback/306_vault_environment_enrollment.rollback.sql`: `2cf4895d3c3562e7e52f9741bbc5c0c968fd61fb832695f29398118becdd2130`
- `rollback/307_consumer_scope_commerce.rollback.sql`: `69961cc7573cdb22bac6258335e5aae05ae4df75c3448e9243947d4fd20dead6`
- `rollback/308_one_shared_hosting_choice.rollback.sql`: `6f5bee22d11d452ce5dc607cb2a01c219977a54e8729bde92f8a61c94b3ed115`
- `rollback/309_public_profile_bridge.rollback.sql`: `0e61c43e175ed02765491f7bd0c4350b49ca644fd5359b5ba860b8652b6a76fd`
- `rollback/310_one_placement_reader_foundation.rollback.sql`: `74d0bb3284087d333d46f9d6436634ad665d270d8986d8764228d60b78675ecf`
- `rollback/311_one_legacy_shared_continuity.rollback.sql`: `74d0bb3284087d333d46f9d6436634ad665d270d8986d8764228d60b78675ecf`
