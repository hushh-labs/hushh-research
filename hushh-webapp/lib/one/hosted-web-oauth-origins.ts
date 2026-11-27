export const UAT_MAIL_ORIGIN = "https://uat.one.hussh.ai";

export const HOSTED_WEB_OAUTH_ORIGINS = new Set<string>([
  "https://one.hussh.si",
  "https://one.hushh.si",
  "https://one.hussh.ai",
  "https://one.hushh.ai",
  "https://uat.one.hussh.si",
  "https://uat.one.hushh.si",
  "https://uat.one.hussh.ai",
  "https://uat.one.hushh.ai",
  "https://dev.one.hussh.si",
  "https://dev.one.hushh.si",
  "https://dev.one.hussh.ai",
  "https://dev.one.hushh.ai",
]);

export function isHostedWebOAuthOrigin(origin: string): boolean {
  return HOSTED_WEB_OAUTH_ORIGINS.has(origin);
}
