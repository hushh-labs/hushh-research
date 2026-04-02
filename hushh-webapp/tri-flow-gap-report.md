# Tri-Flow Gap Report

## Summary

- Page routes audited: 33
- Native-supported routes: 31
- API routes audited: 54
- Missing API contracts: 0
- Accepted exceptions: 0
- Blocking gaps: 0

## Blocking Gaps

- None

## Accepted Exceptions

- None

## Capability Matrix

| Capability | Route | Native | Status | Transport |
| --- | --- | --- | --- | --- |
| `consentsPage` | `/consents` | yes | full_parity | native_plugin, backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `developersPage` | `/developers` | yes | full_parity | backend_contract, native_sdk_or_pkm_service |
| `kaiAnalysisPage` | `/kai/analysis` | yes | full_parity | native_plugin, backend_contract, native_sdk_or_pkm_service |
| `legacyAnalysisRedirectPage` | `/kai/dashboard/analysis` | yes | full_parity | none |
| `kaiDashboardLegacyRedirectPage` | `/kai/dashboard` | yes | full_parity | none |
| `kaiImportPage` | `/kai/import` | yes | full_parity | native_plugin, backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `kaiInvestmentsWrapperPage` | `/kai/investments` | yes | full_parity | native_plugin, backend_contract, native_sdk_or_pkm_service |
| `kaiOnboardingPage` | `/kai/onboarding` | yes | full_parity | native_plugin, backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `kaiOptimizePage` | `/kai/optimize` | yes | full_parity | native_plugin, backend_contract, native_sdk_or_pkm_service |
| `kaiHomePage` | `/kai` | yes | full_parity | native_plugin, backend_contract, native_sdk_or_pkm_service |
| `kaiPlaidOauthReturnPage` | `/kai/plaid/oauth/return` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `kaiDashboardPage` | `/kai/portfolio` | yes | full_parity | native_plugin, backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `profileAppearanceLabPage` | `/labs/profile-appearance` | yes | full_parity | none |
| `loginPage` | `/login` | yes | full_parity | none |
| `logoutPage` | `/logout` | yes | full_parity | native_sdk_or_pkm_service |
| `marketplaceConnectionsPage` | `/marketplace/connections` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `marketplaceConnectionPortfolioPage` | `/marketplace/connections/portfolio` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `marketplacePage` | `/marketplace` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `marketplaceRiaProfilePage` | `/marketplace/ria` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `homePage` | `/` | yes | full_parity | none |
| `portfolioSharedPage` | `/portfolio/shared` | yes | full_parity | none |
| `profileGmailOAuthReturnPage` | `/profile/gmail/oauth/return` | no | intentional_web_only | backend_contract |
| `profilePage` | `/profile` | yes | full_parity | native_plugin, backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `pkmAgentLabPage` | `/profile/pkm-agent-lab` | yes | partial_parity | backend_contract |
| `pkmRedirectPage` | `/profile/pkm` | yes | full_parity | none |
| `profileReceiptsPage` | `/profile/receipts` | no | intentional_web_only | backend_contract |
| `riaClientsPage` | `/ria/clients` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `riaOnboardingPage` | `/ria/onboarding` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `riaHomePage` | `/ria` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `riaPicksPage` | `/ria/picks` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |
| `riaRequestsPage` | `/ria/requests` | yes | full_parity | none |
| `riaSettingsPage` | `/ria/settings` | yes | full_parity | none |
| `riaWorkspacePage` | `/ria/workspace` | yes | full_parity | backend_contract, direct_backend_or_proxy, native_sdk_or_pkm_service |

## API Route Coverage

| Route file | Contract | Status |
| --- | --- | --- |
| `hushh-webapp/app/api/account/delete/route.ts` | `accountDelete` | contracted |
| `hushh-webapp/app/api/app-config/review-mode/route.ts` | - | allowlisted |
| `hushh-webapp/app/api/app-config/review-mode/session/route.ts` | - | allowlisted |
| `hushh-webapp/app/api/auth/session/route.ts` | `authSessionInternal` | contracted |
| `hushh-webapp/app/api/consent/active/route.ts` | `consentSessionMgmt` | contracted |
| `hushh-webapp/app/api/consent/cancel/route.ts` | `consentPendingMgmt` | contracted |
| `hushh-webapp/app/api/consent/center/list/route.ts` | `consentCenterProxy` | contracted |
| `hushh-webapp/app/api/consent/center/route.ts` | `consentCenterProxy` | contracted |
| `hushh-webapp/app/api/consent/center/summary/route.ts` | `consentCenterProxy` | contracted |
| `hushh-webapp/app/api/consent/events/[userId]/route.ts` | - | allowlisted |
| `hushh-webapp/app/api/consent/export-refresh/fail/route.ts` | `consentExportRefreshProxy` | contracted |
| `hushh-webapp/app/api/consent/export-refresh/jobs/route.ts` | `consentExportRefreshProxy` | contracted |
| `hushh-webapp/app/api/consent/export-refresh/upload/route.ts` | `consentExportRefreshProxy` | contracted |
| `hushh-webapp/app/api/consent/history/route.ts` | `consentSessionMgmt` | contracted |
| `hushh-webapp/app/api/consent/logout/route.ts` | `consentSessionMgmt` | contracted |
| `hushh-webapp/app/api/consent/pending/approve/route.ts` | `consentPendingMgmt` | contracted |
| `hushh-webapp/app/api/consent/pending/deny/route.ts` | `consentPendingMgmt` | contracted |
| `hushh-webapp/app/api/consent/pending/route.ts` | `consentPendingMgmt` | contracted |
| `hushh-webapp/app/api/consent/requests/outgoing/route.ts` | `consentCenterProxy` | contracted |
| `hushh-webapp/app/api/consent/requests/route.ts` | `consentCenterProxy` | contracted |
| `hushh-webapp/app/api/consent/revoke/route.ts` | `consentPendingMgmt` | contracted |
| `hushh-webapp/app/api/consent/session-token/route.ts` | `consentSessionMgmt` | contracted |
| `hushh-webapp/app/api/consent/vault-owner-token/route.ts` | `vaultOwnerToken` | contracted |
| `hushh-webapp/app/api/developer/[...path]/route.ts` | `developerLiveDocsProxy` | contracted |
| `hushh-webapp/app/api/iam/[...path]/route.ts` | `iamProxy` | contracted |
| `hushh-webapp/app/api/investors/[id]/route.ts` | `investorsPublic` | contracted |
| `hushh-webapp/app/api/investors/search/route.ts` | `investorsPublic` | contracted |
| `hushh-webapp/app/api/invites/[token]/accept/route.ts` | `inviteProxy` | contracted |
| `hushh-webapp/app/api/invites/[token]/route.ts` | `inviteProxy` | contracted |
| `hushh-webapp/app/api/kai/[...path]/route.ts` | `kaiProxy` | contracted |
| `hushh-webapp/app/api/marketplace/[...path]/route.ts` | `marketplaceProxy` | contracted |
| `hushh-webapp/app/api/notifications/register/route.ts` | `notificationsPublic` | contracted |
| `hushh-webapp/app/api/notifications/unregister/route.ts` | `notificationsPublic` | contracted |
| `hushh-webapp/app/api/pkm/[...path]/route.ts` | `pkmProxy` | contracted |
| `hushh-webapp/app/api/portfolio/share-link/route.ts` | `portfolioShareInternal` | contracted |
| `hushh-webapp/app/api/ria/[...path]/route.ts` | `riaProxy` | contracted |
| `hushh-webapp/app/api/tickers/all/route.ts` | `tickersPublic` | contracted |
| `hushh-webapp/app/api/tickers/search/route.ts` | `tickersPublic` | contracted |
| `hushh-webapp/app/api/tickers/sync-holdings/[userId]/route.ts` | `tickersPublic` | contracted |
| `hushh-webapp/app/api/vault/bootstrap-state/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/check/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/get/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/pre-vault-state/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/primary/set/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/setup/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/vault/status/route.ts` | `vaultStatus` | contracted |
| `hushh-webapp/app/api/vault/store-preferences/route.ts` | `tokenValidationAndAgentChat` | contracted |
| `hushh-webapp/app/api/vault/wrapper/upsert/route.ts` | `vaultWebProxy` | contracted |
| `hushh-webapp/app/api/world-model/[...path]/route.ts` | `worldModelProxy` | contracted |
| `hushh-webapp/app/api/world-model/domains/[userId]/route.ts` | `worldModelProxy` | contracted |
| `hushh-webapp/app/api/world-model/domains/route.ts` | `worldModelProxy` | contracted |
| `hushh-webapp/app/api/world-model/metadata/[userId]/route.ts` | `worldModelProxy` | contracted |
| `hushh-webapp/app/api/world-model/scopes/[userId]/route.ts` | `worldModelProxy` | contracted |
| `hushh-webapp/app/api/world-model/store-domain/route.ts` | `worldModelProxy` | contracted |

