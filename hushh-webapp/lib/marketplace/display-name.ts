const PRESERVED_MARKETPLACE_TOKENS = new Map<string, string>([
  ["AI", "AI"],
  ["ETF", "ETF"],
  ["L.P.", "L.P."],
  ["LLC", "LLC"],
  ["LP", "LP"],
  ["RIA", "RIA"],
  ["SEC", "SEC"],
  ["UK", "UK"],
  ["USA", "USA"],
]);

const MARKETPLACE_TITLE_SUFFIXES = new Map<string, string>([
  ["CO", "Co"],
  ["CO.", "Co."],
  ["CORP", "Corp"],
  ["CORP.", "Corp."],
  ["INC", "Inc"],
  ["INC.", "Inc."],
  ["LTD", "Ltd"],
  ["LTD.", "Ltd."],
]);

function isMostlyUppercase(value: string): boolean {
  const letters = value.match(/[A-Za-z]/g) ?? [];
  if (letters.length === 0) return false;
  const uppercaseLetters = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return uppercaseLetters / letters.length >= 0.8;
}

function titleCaseWord(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z']*/g, (word) => {
    const lower = word.toLowerCase();
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  });
}

function normalizeMarketplaceToken(token: string): string {
  const commaSuffix = token.endsWith(",") ? "," : "";
  const core = commaSuffix ? token.slice(0, -1) : token;
  const normalizedCore = core.toUpperCase();

  const preserved = PRESERVED_MARKETPLACE_TOKENS.get(normalizedCore);
  if (preserved) return `${preserved}${commaSuffix}`;

  const suffix = MARKETPLACE_TITLE_SUFFIXES.get(normalizedCore);
  if (suffix) return `${suffix}${commaSuffix}`;

  return `${core
    .split("-")
    .map((part) => titleCaseWord(part))
    .join("-")}${commaSuffix}`;
}

export function formatMarketplaceDisplayName(rawName: string | null | undefined): string {
  const name = String(rawName ?? "").trim();
  if (!name) return "";
  if (!isMostlyUppercase(name)) return name;
  return name.split(/\s+/).map(normalizeMarketplaceToken).join(" ");
}
