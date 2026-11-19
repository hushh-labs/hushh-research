// Source for both the deterministic design matrix and the native QA receipt.
import { locationUatCases } from "./location-feed-uat-journey.mjs";
export const previewTime = "2026-10-16T15:30:00Z";
const driveApi = "/api/connectors/google_drive/sharing/requests/{id}";
const driveOwner = "/one/consent?tab=pending&requestId=document_share_request%3A{id}&from=%2Fone%2Ffeed";
const driveRequester = driveOwner + "&requestView=sent";
const kycApi = "/api/one/email/information-requests/{id}";
const advisorApi = "/api/one/finance/advisor-reviews/{id}";
const importReview = "/one/kai/import?from=%2Fone%2Ffeed&stage=reviewing&import_run_id={id}";
const savedStatement = "/one/kai/import?from=%2Fone%2Ffeed&statement_id={id}";
const savedAnalysis = "/one/kai?tab=analysis&analysis_id=run%3A{id}&from=%2Fone%2Ffeed";
const transfer = "/one/feed?funding_event={id}";
const institution = "/one/kai/portfolio/sources?reconnect={id}&from=%2Fone%2Ffeed";
const advisor = "/ria/clients?advisorReview={id}";
const investor = "/one/kai/portfolio/analysis?advisorReview={id}";

export const cases = [
  ["01-kyc-review", "KYC and document sharing", "kyc", "kyc-owner", "Reply awaiting review", "Maya asked for your information", "Review", "/one/gmail?workspace=kyc&from=%2Fone%2Ffeed", kycApi],
  ["02-kyc-replied", "KYC and document sharing", "kyc", "kyc-owner", "Provider confirmed reply sent", "You replied to Maya", null, "/one/feed", "GET /api/one/feed/{item}/activity; confirmed workflow.reply_send_action_id"],
  ["03-document-requester", "KYC and document sharing", "document", "requester", "Request submitted", "You requested files from Rowan", null, driveRequester, driveApi],
  ["04-document-owner", "KYC and document sharing", "document", "document-owner", "Request pending owner decision", "Maya requested files from you", "Review", driveOwner, driveApi + "/review"],
  ["05-document-connect", "KYC and document sharing", "document", "document-owner", "Drive connection required", "Connect Google Drive to review this request", "Connect", driveOwner, driveApi + "/review"],
  ["06-document-connected", "KYC and document sharing", "document", "document-owner", "Drive authorized; same request open", "Maya requested files from you", "Review", driveOwner, driveApi + "/review"],
  ["07-payment", "KYC and document sharing", "document", "requester", "Awaiting sandbox payment", "Pay $2.00 for your file request", "Pay", driveRequester, "Stripe test checkout + " + driveApi],
  ["08-document-partial", "KYC and document sharing", "document", "requester", "1 of 2 file grants confirmed", "1 of 2 files from Rowan is ready", null, driveRequester, driveApi + "/delivery"],
  ["09-document-final", "KYC and document sharing", "document", "requester", "2 file grants confirmed", "2 files from Rowan are ready", null, driveRequester, driveApi + "/delivery"],
  ["10-document-folded", "KYC and document sharing", "document", "requester", "One current row, milestones retained", "2 files from Rowan are ready", null, driveRequester, "GET /api/one/feed + " + driveApi],
  ["11-search-request", "KYC and document sharing", "old-document", "requester", "Earlier request remains accessible", "File request from Rowan", "Open", driveRequester, driveApi],
  ["12-search-file", "KYC and document sharing", "old-document", "requester", "Existing file grant still authorizes access", "QA October statement.pdf", "Open", driveRequester, driveApi + "/delivery/files"],
  ["13-search-receipt", "KYC and document sharing", "old-document", "requester", "Sandbox payment receipt verified", "Receipt for your file request", "Open", driveRequester, "Stripe test receipt + " + driveApi],
  ["14-statement-review", "Finance", "import-run", "investor", "Parsing finished; draft unsaved", "Your October statement is ready to review", "Review", importReview, "Authenticated import run + same-device completed draft"],
  ["15-statement-correction", "Finance", "import-run", "investor", "Existing review validation requires a price", "Check the price for 1 holding", "Review", importReview + "&fix_field=price", "Same import run + current holding validator"],
  ["16-statement-saved", "Finance", "import-run", "investor", "Vault snapshot committed and readable", "October statement · Saved statement", "Open", savedStatement, "Owner vault financial statements + mutation receipt"],
  ["17-analysis-saved", "Finance", "analysis", "investor", "Exact report saved outside Finance", "Your AAPL analysis is ready", null, savedAnalysis, "Encrypted analysis history + /api/kai/analyze/run/{id}/feed-result"],
  ["18-transfer-returned", "Finance", "transfer", "investor", "Returned after completion; provider proof required", "Your transfer was returned", null, transfer, "Retired provider; retained evidence via POST /api/one/feed/funding-history"],
  ["19-advisor-received", "Finance", "advisor", "advisor", "Current incoming pending request", "Maya asked you to review their portfolio", "Review", advisor, advisorApi],
  ["20-advisor-investor", "Finance", "advisor", "investor", "Advisor accepted the same request", "Your advisor accepted your review request", null, investor, advisorApi],
  ["21-institution-action", "Finance", "institution", "investor", "Provider confirms ITEM_LOGIN_REQUIRED", "Reconnect Example Bank to update your accounts", "Reconnect", institution, "Owner vault connection + Plaid Sandbox snapshot"],
  ["22-institution-return", "Finance", "institution", "investor", "Same active item and accounts committed; action gone", "This connection is active", null, institution, "Owner vault item-version and account readback after OAuth"],
  ["23-search-statement", "Finance", "old-statement", "investor", "Older saved snapshot still authorized", "October statement · Saved statement", "Open", savedStatement, "Owner vault financial statements"],
  ["24-search-report", "Finance", "old-analysis", "investor", "Older exact saved report still authorized", "AAPL · Saved analysis", "Open", savedAnalysis, "Owner vault analysis history"],
  ["25-search-transfer", "Finance", "old-transfer", "investor", "Retained historical transfer found", "Your transfer was returned", "Open", transfer, "POST /api/one/feed/funding-history"],
  ["26-search-advisor", "Finance", "old-advisor", "investor", "Earlier advisor request still authorized", "Rowan · Advisor request accepted", "Open", investor, advisorApi],
  ["27-history-refresh", "Legacy UAT history", "legacy-feed", "requester", "Same operation once, no duplicate unread after refresh", "2 files from Rowan are ready", null, driveRequester, "GET /api/one/feed, /api/one/feed/unread-count from two sessions"],
].map(([key, section, family, role, state, copy, action, destination, authority]) =>
  Object.freeze({ key, section, family, role, state, copy, action, destination, authority })
);

export function previewId(family) {
  const known = [...new Set(cases.map(row => row.family))].indexOf(family) + 1;
  const index = known || [...family].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0);
  if (family.includes("transfer")) return String(7000 + index);
  return "10000000-1000-4000-8000-" + String(index).padStart(12, "0");
}

export const uatCases = [...cases, ...locationUatCases];

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
);
