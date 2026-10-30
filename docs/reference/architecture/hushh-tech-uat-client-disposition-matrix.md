# Hussh Research — HushhTech UAT Client Disposition Matrix

## Visual Context

Canonical visual owner: [Hussh Architecture Index](./README.md). This page is the frozen, current-state disposition contract for the `HushhTech` UAT client delivery.

## Status and Evidence Boundary

- Classification: `canonical`
- Inventory captured: `2026-08-20T23:59:00Z`
- Primary legacy Supabase project: `ibsisfnjxeowvdtvgzff` (`hushh-ai`, `ap-south-1`)
- Checked-in `HushhTech` source baseline: `d2cecbc2dcacc612570211ac8ee69cd157275870`
- Current UAT serving revision at capture: `hushh-tech-website-00226-hob`, 100% traffic, revision tag `build-d2cecbc2`
- Evidence: read-only Supabase control-plane inventory, checked-in `HushhTech` source, and the JavaScript served by `https://uat.hushhtech.com`
- Delivery boundary: synthetic allowlisted UAT cohort only; no production Supabase connection, export, user migration, function deployment, storage copy, secret read, or live mutation

The inventory is a disposition record, not a migration map. Every production Supabase surface below stays in the legacy system and is unavailable to the GCP cohort. Hushh Research owns the synthetic UAT compatibility records described separately below.

## Count Reconciliation

| Surface | Frozen total | Reconciliation |
| --- | ---: | --- |
| Public database tables | 70 | 70 `LEGACY_UNCHANGED`; 0 available to the GCP cohort |
| Active Edge Functions | 112 | 80 `SOURCE_BACKED` + 32 `LIVE_ONLY` = 112 |
| Edge Function JWT settings | 112 | 62 `true` + 50 `false` = 112 |
| Storage buckets | 6 | 5 public + 1 private = 6; all `LEGACY_UNCHANGED` |
| Supabase hosts in the current UAT bundle | 1 | Primary project host only; 0 secondary hosts |

## Disposition Vocabulary

| Value | Meaning in this delivery |
| --- | --- |
| `LEGACY_UNCHANGED` | The legacy surface remains where it is, receives no change from this delivery, and is unavailable to the allowlisted GCP cohort. |
| `DO_NOT_PORT` | The deployed legacy surface remains untouched and must never be copied into the Research service or exposed through the `HushhTech` compatibility gateway. |
| `SOURCE_BACKED` | A matching checked-in `HushhTech` Edge Function source directory was present at capture time. |
| `LIVE_ONLY` | The function was active in Supabase but no matching checked-in `HushhTech` source directory was present at capture time. |

## Synthetic GCP Cohort Contract — Not a Production Table Map

The following structures are additive Hushh Research Cloud SQL records for checked-in synthetic fixtures and UAT control state. They are not copies, renames, or row-level mappings of any production table in the 70-table inventory.

| Synthetic or control record | Research Cloud SQL owner | Production mapping | Allowed content |
| --- | --- | --- | --- |
| `profile` | `hushh_tech_shadow_records` | None | Synthetic profile metadata from checked-in fixtures |
| `onboarding` | `hushh_tech_shadow_records` | None | Synthetic onboarding metadata from checked-in fixtures |
| `access_state` | `hushh_tech_shadow_records` | None | Synthetic feature and access-state metadata |
| `report_asset` | `hushh_tech_shadow_records` | None | Synthetic report-asset metadata only; no storage object |
| Single-use launch authorization | `hushh_tech_launch_authorizations` | None | Hashed PKCE launch code state, exact audience and redirect, expiry, and consumption metadata |
| Product-account link | `hushh_tech_account_links` | None | Firebase UID authority plus legacy UUID provenance for synthetic UAT proof |
| Link and revocation audit | `hushh_tech_link_events` | None | Append-only link attempts, conflicts, activation, recovery, and revocation metadata |
| Fixture replay checkpoint | `hushh_tech_migration_runs` | None | Fixture hashes, counts, checkpoints, and deterministic replay status |
| Fixture import audit | `hushh_tech_migration_events` | None | Append-only run start, transactional record outcomes, failure, and completion metadata |

Firebase UID is the only canonical user identifier. Real legacy-account linking, production row reconciliation, payments, Plaid, KYC, NDA records, webhooks, and storage objects are outside this delivery. Consent and global revocation remain Hushh Research authority; they are not imported from a legacy table.

## Public Database Table Matrix

| # | Public table | Delivery disposition | GCP cohort |
| ---: | --- | --- | --- |
| 1 | `agent_profiles` | `LEGACY_UNCHANGED` | Unavailable |
| 2 | `agent_reviews` | `LEGACY_UNCHANGED` | Unavailable |
| 3 | `analytics_events` | `LEGACY_UNCHANGED` | Unavailable |
| 4 | `app_config` | `LEGACY_UNCHANGED` | Unavailable |
| 5 | `blocked_agents` | `LEGACY_UNCHANGED` | Unavailable |
| 6 | `blog_drafts` | `LEGACY_UNCHANGED` | Unavailable |
| 7 | `ceo_meeting_payments` | `LEGACY_UNCHANGED` | Unavailable |
| 8 | `community_registrations` | `LEGACY_UNCHANGED` | Unavailable |
| 9 | `consents` | `LEGACY_UNCHANGED` | Unavailable |
| 10 | `consumer_profiles` | `LEGACY_UNCHANGED` | Unavailable |
| 11 | `content_items` | `LEGACY_UNCHANGED` | Unavailable |
| 12 | `content_versions` | `LEGACY_UNCHANGED` | Unavailable |
| 13 | `conversations` | `LEGACY_UNCHANGED` | Unavailable |
| 14 | `delete_requests` | `LEGACY_UNCHANGED` | Unavailable |
| 15 | `deleted_account_payment_audits` | `LEGACY_UNCHANGED` | Unavailable |
| 16 | `devices` | `LEGACY_UNCHANGED` | Unavailable |
| 17 | `fund_admin_access_log` | `LEGACY_UNCHANGED` | Unavailable |
| 18 | `fund_investment_plans` | `LEGACY_UNCHANGED` | Unavailable |
| 19 | `fund_investor_notes` | `LEGACY_UNCHANGED` | Unavailable |
| 20 | `fund_investor_tags` | `LEGACY_UNCHANGED` | Unavailable |
| 21 | `fund_payment_notifications` | `LEGACY_UNCHANGED` | Unavailable |
| 22 | `fund_payment_reviews` | `LEGACY_UNCHANGED` | Unavailable |
| 23 | `fund_recurring_transfers` | `LEGACY_UNCHANGED` | Unavailable |
| 24 | `fund_stripe_events` | `LEGACY_UNCHANGED` | Unavailable |
| 25 | `fund_stripe_payment_requests` | `LEGACY_UNCHANGED` | Unavailable |
| 26 | `fund_stripe_payments` | `LEGACY_UNCHANGED` | Unavailable |
| 27 | `fund_stripe_subscriptions` | `LEGACY_UNCHANGED` | Unavailable |
| 28 | `fund_transfers` | `LEGACY_UNCHANGED` | Unavailable |
| 29 | `identity_verifications` | `LEGACY_UNCHANGED` | Unavailable |
| 30 | `investor_profiles` | `LEGACY_UNCHANGED` | Unavailable |
| 31 | `kirkland_agents` | `LEGACY_UNCHANGED` | Unavailable |
| 32 | `kyc_profiles` | `LEGACY_UNCHANGED` | Unavailable |
| 33 | `lead_events` | `LEGACY_UNCHANGED` | Unavailable |
| 34 | `lead_requests` | `LEGACY_UNCHANGED` | Unavailable |
| 35 | `messages` | `LEGACY_UNCHANGED` | Unavailable |
| 36 | `nda_signatures` | `LEGACY_UNCHANGED` | Unavailable |
| 37 | `notifications` | `LEGACY_UNCHANGED` | Unavailable |
| 38 | `onboarding_data` | `LEGACY_UNCHANGED` | Unavailable |
| 39 | `onboarding_invites` | `LEGACY_UNCHANGED` | Unavailable |
| 40 | `onboarding_parties` | `LEGACY_UNCHANGED` | Unavailable |
| 41 | `otp_codes` | `LEGACY_UNCHANGED` | Unavailable |
| 42 | `plaid_accounts` | `LEGACY_UNCHANGED` | Unavailable |
| 43 | `plaid_data_events` | `LEGACY_UNCHANGED` | Unavailable |
| 44 | `plaid_items` | `LEGACY_UNCHANGED` | Unavailable |
| 45 | `plaid_link_diagnostics` | `LEGACY_UNCHANGED` | Unavailable |
| 46 | `plaid_product_sync_statuses` | `LEGACY_UNCHANGED` | Unavailable |
| 47 | `plaid_statement_metadata` | `LEGACY_UNCHANGED` | Unavailable |
| 48 | `plaid_sync_cursors` | `LEGACY_UNCHANGED` | Unavailable |
| 49 | `plaid_transactions` | `LEGACY_UNCHANGED` | Unavailable |
| 50 | `plaid_transfer_accounts` | `LEGACY_UNCHANGED` | Unavailable |
| 51 | `plaid_transfer_events` | `LEGACY_UNCHANGED` | Unavailable |
| 52 | `site_analytics_events` | `LEGACY_UNCHANGED` | Unavailable |
| 53 | `site_analytics_sessions` | `LEGACY_UNCHANGED` | Unavailable |
| 54 | `swipe_actions` | `LEGACY_UNCHANGED` | Unavailable |
| 55 | `transfer_email_notifications` | `LEGACY_UNCHANGED` | Unavailable |
| 56 | `user_agent_selections` | `LEGACY_UNCHANGED` | Unavailable |
| 57 | `user_enriched_profiles` | `LEGACY_UNCHANGED` | Unavailable |
| 58 | `user_financial_data` | `LEGACY_UNCHANGED` | Unavailable |
| 59 | `user_product_usage` | `LEGACY_UNCHANGED` | Unavailable |
| 60 | `users` | `LEGACY_UNCHANGED` | Unavailable |
| 61 | `wa_classifications` | `LEGACY_UNCHANGED` | Unavailable |
| 62 | `wa_extractions` | `LEGACY_UNCHANGED` | Unavailable |
| 63 | `wa_groups` | `LEGACY_UNCHANGED` | Unavailable |
| 64 | `wa_jobs` | `LEGACY_UNCHANGED` | Unavailable |
| 65 | `wa_links` | `LEGACY_UNCHANGED` | Unavailable |
| 66 | `wa_media` | `LEGACY_UNCHANGED` | Unavailable |
| 67 | `wa_messages` | `LEGACY_UNCHANGED` | Unavailable |
| 68 | `wa_review_actions` | `LEGACY_UNCHANGED` | Unavailable |
| 69 | `wa_sender_identities` | `LEGACY_UNCHANGED` | Unavailable |
| 70 | `wa_senders` | `LEGACY_UNCHANGED` | Unavailable |

## Active Edge Function Matrix

The `verify_jwt` column records the deployed Supabase setting captured at the timestamp above. It does not assert that the function has any additional application-level authorization.

| # | Edge Function | Source class | `verify_jwt` | Delivery disposition | GCP cohort |
| ---: | --- | --- | --- | --- | --- |
| 1 | `activate-agent` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 2 | `agent-onboard-notify` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 3 | `asset-report-create` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 4 | `asset-report-get` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 5 | `bank-income` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 6 | `bot_event` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 7 | `bot_start` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 8 | `ceo-calendar-booking` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 9 | `chat-check-access` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 10 | `chat-create-checkout` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 11 | `chat-verify-payment` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 12 | `claude-code-gen` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 13 | `coins-credit-notification` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 14 | `coins-deduction-notification` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 15 | `create-link-token` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 16 | `create-verification-session` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 17 | `delete-user-account` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 18 | `exchange-public-token` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 19 | `fund-coupon-redeem` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 20 | `fund-payment-admin-analytics` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 21 | `fund-payment-admin-crm` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 22 | `fund-payment-admin-detail` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 23 | `fund-payment-admin-kyc-review` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 24 | `fund-payment-admin-kyc-screen` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 25 | `fund-payment-admin-list` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 26 | `fund-payment-admin-overview` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 27 | `fund-payment-admin-overview-list` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 28 | `fund-payment-admin-overview-metrics` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 29 | `fund-payment-admin-remind` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 30 | `fund-payment-admin-resend` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 31 | `fund-payment-admin-verify` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 32 | `fund-payment-checkout` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 33 | `fund-payment-request-create` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 34 | `fund-payment-status` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 35 | `fund-payment-token-status` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 36 | `fund-stripe-webhook` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 37 | `fund-transfer-sandbox-start` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 38 | `gemini-voice-token` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 39 | `generate-investor-profile` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 40 | `get-auth-numbers` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 41 | `get-locations` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 42 | `get-secrets` | `LIVE_ONLY` | `false` | `DO_NOT_PORT` | Unavailable |
| 43 | `github-devops-notify` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 44 | `hushh-address-inference` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 45 | `hushh-ai-chat` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 46 | `hushh-dob-inference` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 47 | `hushh-location-geocode` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 48 | `hushh-profile-search` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 49 | `identity-verification-webhook` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 50 | `investments-transactions` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 51 | `investor-agent-mcp` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 52 | `investor-chat` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 53 | `investor-og-image` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 54 | `ios-build-tracker` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 55 | `kyc-agent-a2a` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 56 | `kyc-agent-a2a-protocol` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 57 | `kyc-agent-agentic` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 58 | `kyc-orchestrator` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 59 | `lead_create` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 60 | `liabilities` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 61 | `mcp-agent-card` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 62 | `nda-admin-fetch` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 63 | `nda-signed-notification` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 64 | `nws-score-notification` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 65 | `onboarding-create-checkout` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 66 | `onboarding-funding-name-match` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 67 | `onboarding-invite-complete` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 68 | `onboarding-invite-create` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 69 | `onboarding-invite-link-token` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 70 | `onboarding-invite-load` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 71 | `onboarding-invite-plaid-exchange` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 72 | `onboarding-invite-resend` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 73 | `onboarding-invite-revoke` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 74 | `onboarding-invite-save` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 75 | `onboarding-proof-of-funds` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 76 | `onboarding-submit-application` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 77 | `onboarding-verify-payment` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 78 | `plaid-data-sync` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 79 | `plaid-data-sync-product` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 80 | `plaid-data-sync-start` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 81 | `plaid-data-webhook` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 82 | `plaid-diagnostics-log` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 83 | `plaid-income-link-token` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 84 | `plaid-transfer-sandbox-simulate` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 85 | `plaid-transfer-webhook` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 86 | `plaid-unlink-item` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 87 | `portfolio-deploy` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 88 | `portfolio-generate` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 89 | `portfolio-photo-enhance` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 90 | `portfolio-slug-check` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 91 | `public-signup-metrics` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 92 | `sandbox-create-test-item` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 93 | `send-email-notification` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 94 | `send-kyc-email` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 95 | `shadow-investigator` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 96 | `signal-decision-report` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 97 | `signal-evaluate` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 98 | `signal-return-report` | `SOURCE_BACKED` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 99 | `site-analyze` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 100 | `site-edit` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 101 | `site-extract` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 102 | `site-generate` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 103 | `site-orchestrator` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 104 | `site-publish` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 105 | `stock-quotes` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 106 | `stripe-identity-session` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 107 | `stripe-identity-webhook` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 108 | `ticket_create` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 109 | `transactions-sync` | `LIVE_ONLY` | `false` | `LEGACY_UNCHANGED` | Unavailable |
| 110 | `vault-access-notification` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 111 | `veo-generate-video` | `SOURCE_BACKED` | `true` | `LEGACY_UNCHANGED` | Unavailable |
| 112 | `voice-agent-turn` | `LIVE_ONLY` | `true` | `LEGACY_UNCHANGED` | Unavailable |

## Storage Bucket Matrix

The access flag is the legacy bucket setting captured at the timestamp above. No bucket, object, policy, or metadata is copied by this delivery.

| # | Bucket | Legacy access | Delivery disposition | GCP cohort |
| ---: | --- | --- | --- | --- |
| 1 | `assets` | Public | `LEGACY_UNCHANGED` | Unavailable |
| 2 | `community-uploads` | Public | `LEGACY_UNCHANGED` | Unavailable |
| 3 | `hushh-agent-profile-images` | Public | `LEGACY_UNCHANGED` | Unavailable |
| 4 | `hushh-ai-media` | Public | `LEGACY_UNCHANGED` | Unavailable |
| 5 | `hushh-gamma-pdf` | Public | `LEGACY_UNCHANGED` | Unavailable |
| 6 | `wa-evidence` | Private | `LEGACY_UNCHANGED` | Unavailable |

## Secondary Supabase Reference and Caller Matrix

These entries are references outside the primary legacy client binding. Presence in source or documentation does not prove a deployed connection.

| Reference | Checked-in callers or evidence | Captured runtime posture | Delivery disposition |
| --- | --- | --- | --- |
| `VITE_MARKET_SUPABASE_URL` | `src/services/reportService.ts`; `src/pages/reports/reportDetail.tsx`; `src/App.tsx` route `/reports/:id` | Reachable, environment-driven route in source; the current UAT workflow does not materialize this variable and the current bundle contains no secondary host | `LEGACY_UNCHANGED`; unavailable to GCP cohort |
| `spmxyqxjqxcyywkapong` | `src/services/storageBuckets.ts`; `src/scripts/testReportsApi.js` | Hard-coded in an unimported runtime helper and a test script; absent from the current UAT bundle | `LEGACY_UNCHANGED`; unavailable to GCP cohort |
| `hkdlmkpqwbjnmcwlxczv` | `src/components/kyc/screens/KycFlowContainer.tsx` | Dormant fallback; `/kyc-flow`, `/kyc-demo`, and `/a2a-playground` redirect to `/`; absent from the current UAT bundle | `LEGACY_UNCHANGED`; unavailable to GCP cohort |
| `LEGACY_SUPABASE_URL` | [api/metrics/service.js](https://github.com/hushh-labs/hushh_Tech_website/blob/main/api/metrics/service.js); [scripts/deploy-gcp.sh](https://github.com/hushh-labs/hushh_Tech_website/blob/main/scripts/deploy-gcp.sh) | Optional server metrics source; current `hushh-tech-website` has no binding | `LEGACY_UNCHANGED`; unavailable to GCP cohort |
| `gsqmwxqgqrgzhlhmbscg` | Archived documentation only | No runtime caller or current UAT bundle host | Non-runtime reference; unchanged |
| `qoeqfmeimagulpzjptbj` | Documentation only | No runtime caller or current UAT bundle host | Non-runtime reference; unchanged |
| `jbvfjyxpjyspafqzohmi` | Setup-script output text only | No runtime caller or current UAT bundle host | Non-runtime reference; unchanged |
| `rpmzykoxqnbozgdoqbpc` | Documentation and negative tests only | No runtime caller or current UAT bundle host | Non-runtime reference; unchanged |

## Current UAT Bundle Evidence

At `2026-08-20T23:59:00Z`, the JavaScript served by `https://uat.hushhtech.com` contained exactly one Supabase hostname: `https://ibsisfnjxeowvdtvgzff.supabase.co`. No secondary Supabase hostname from the matrix above appeared in the served artifact.

This is primary-host-only artifact evidence. It does not prove that every code path called that host, that authentication succeeded, or that dormant server-side environment variables were absent outside the inspected Cloud Run service configuration.

## Delivery Invariants

1. The allowlisted GCP cohort never reads production Supabase records or storage.
2. A migrated cohort fails closed for every legacy-only surface; it does not silently fall back to production Supabase.
3. No owner token, connector private key, Supabase key, database credential, or secret value belongs in this document or the compatibility API.
4. The legacy project, 70 tables, 112 active functions, six buckets, migrations, users, and secrets remain untouched.
5. Any future production migration requires a separately authorized, refreshed inventory and a new row-level source, reconciliation, consent, and rollback contract.
