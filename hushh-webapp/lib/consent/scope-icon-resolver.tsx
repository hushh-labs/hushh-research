"use client";

import type { ComponentType } from "react";
import {
  AirplaneTilt,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Car,
  Coins,
  ContactRound,
  Cpu,
  CreditCard,
  FileText,
  FolderSimpleIcon,
  ForkKnife,
  Globe,
  GraduationCap,
  Heart,
  Home,
  Landmark,
  Laptop,
  LineChart,
  LockKeyhole,
  Mail,
  MapPin,
  PieChart,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  UserRound,
  UsersRound,
  Wallet,
} from "@/components/icons";

export type ScopeIconTone = "green" | "blue" | "purple" | "orange";
export type ScopeGlyphComponent = ComponentType<{
  className?: string;
  weight?: "regular" | "fill";
  color?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export type ResolvedScopeIcon = {
  Icon: ScopeGlyphComponent;
  tone: ScopeIconTone;
  iconKey: string;
};

const ICON_REGISTRY: Record<string, { Icon: ScopeGlyphComponent; tone: ScopeIconTone }> = {
  bank: { Icon: Landmark, tone: "green" },
  landmark: { Icon: Landmark, tone: "green" },
  wallet: { Icon: Wallet, tone: "orange" },
  "credit-card": { Icon: CreditCard, tone: "green" },
  receipt: { Icon: Receipt, tone: "green" },
  "chart-line": { Icon: LineChart, tone: "green" },
  "line-chart": { Icon: LineChart, tone: "green" },
  "chart-pie": { Icon: PieChart, tone: "green" },
  "pie-chart": { Icon: PieChart, tone: "green" },
  coins: { Icon: Coins, tone: "orange" },
  "shield-check": { Icon: ShieldCheck, tone: "orange" },
  shield: { Icon: ShieldCheck, tone: "orange" },
  "lock-key": { Icon: LockKeyhole, tone: "orange" },
  "identification-card": { Icon: ContactRound, tone: "purple" },
  "id-card": { Icon: ContactRound, tone: "purple" },
  "user-circle": { Icon: UserRound, tone: "purple" },
  "user-round": { Icon: UserRound, tone: "purple" },
  "users-three": { Icon: UsersRound, tone: "blue" },
  users: { Icon: UsersRound, tone: "blue" },
  heart: { Icon: Heart, tone: "orange" },
  airplane: { Icon: AirplaneTilt, tone: "blue" },
  plane: { Icon: AirplaneTilt, tone: "blue" },
  "fork-knife": { Icon: ForkKnife, tone: "orange" },
  utensils: { Icon: ForkKnife, tone: "orange" },
  briefcase: { Icon: Briefcase, tone: "purple" },
  "graduation-cap": { Icon: GraduationCap, tone: "purple" },
  house: { Icon: Home, tone: "blue" },
  home: { Icon: Home, tone: "blue" },
  car: { Icon: Car, tone: "blue" },
  "shopping-bag": { Icon: ShoppingBag, tone: "orange" },
  "calendar-blank": { Icon: Calendar, tone: "blue" },
  calendar: { Icon: Calendar, tone: "blue" },
  "envelope-simple": { Icon: Mail, tone: "orange" },
  mail: { Icon: Mail, tone: "orange" },
  "map-pin": { Icon: MapPin, tone: "blue" },
  map: { Icon: MapPin, tone: "blue" },
  "file-text": { Icon: FileText, tone: "blue" },
  "book-open": { Icon: BookOpen, tone: "purple" },
  cpu: { Icon: Cpu, tone: "blue" },
  globe: { Icon: Globe, tone: "blue" },
  buildings: { Icon: Building2, tone: "purple" },
  television: { Icon: Laptop, tone: "purple" },
  tv: { Icon: Laptop, tone: "purple" },
  "folder-simple": { Icon: FolderSimpleIcon, tone: "blue" },
};

const SEMANTIC_RULES: ReadonlyArray<{ key: string; keywords: readonly string[] }> = [
  { key: "credit-card", keywords: ["liability", "liabilities", "credit", "loan", "mortgage", "debt", "card", "apr", "utilization"] },
  { key: "receipt", keywords: ["statement", "statements", "tax", "invoice", "receipt", "billing", "bill", "bills", "expense", "1099", "w2"] },
  { key: "chart-pie", keywords: ["holding", "holdings", "portfolio", "allocation", "equity", "equities", "ira", "401k", "brokerage", "schwab", "fidelity", "vanguard"] },
  { key: "chart-line", keywords: ["analytics", "summary", "cashflow", "cash_flow", "performance", "net_worth", "networth", "market", "security", "securities", "stock"] },
  { key: "wallet", keywords: ["payout", "payouts", "stripe", "wallet", "payment", "payments", "income", "salary", "compensation", "earnings"] },
  { key: "bank", keywords: ["financial", "finance", "bank", "banking", "checking", "savings", "depository", "plaid", "chase", "bofa", "citibank", "account", "accounts"] },
  { key: "identification-card", keywords: ["kyc", "passport", "license", "ssn", "ein", "verification", "citizenship", "visa", "immigration", "identity"] },
  { key: "heart", keywords: ["health", "medical", "fitness", "wellness", "workout", "sleep", "allergy", "medication", "nutrition"] },
  { key: "airplane", keywords: ["travel", "flight", "airline", "hotel", "itinerary", "trip", "vacation", "miles", "airport"] },
  { key: "fork-knife", keywords: ["food", "dining", "restaurant", "cuisine", "coffee", "diet", "dietary", "meal", "recipe"] },
  { key: "graduation-cap", keywords: ["education", "university", "college", "school", "degree", "course", "academic", "certification", "research"] },
  { key: "house", keywords: ["housing", "home", "real_estate", "lease", "rent", "property", "address", "residence"] },
  { key: "car", keywords: ["vehicle", "automotive", "car", "driving", "transit", "commute"] },
  { key: "television", keywords: ["entertainment", "media", "music", "movie", "streaming", "gaming", "podcast"] },
  { key: "shopping-bag", keywords: ["shopping", "commerce", "retail", "order", "purchase", "wardrobe", "subscription"] },
  { key: "calendar-blank", keywords: ["calendar", "schedule", "meeting", "appointment", "availability", "event", "events"] },
  { key: "envelope-simple", keywords: ["email", "gmail", "inbox", "newsletter", "correspondence"] },
  { key: "map-pin", keywords: ["location", "place", "places", "neighborhood", "city", "nearby"] },
  { key: "cpu", keywords: ["engineering", "software", "code", "tech", "stack", "infrastructure", "cloud", "ai", "developer", "tooling"] },
  { key: "buildings", keywords: ["company", "organization", "enterprise", "vendor", "business", "businesses", "employer"] },
  { key: "briefcase", keywords: ["professional", "career", "work", "employment", "resume", "role", "project", "consulting"] },
  { key: "users-three", keywords: ["social", "family", "friends", "network", "relationship", "community", "circle", "people", "colleague"] },
  { key: "lock-key", keywords: ["security", "credential", "vault", "privacy", "permission", "consent"] },
  { key: "book-open", keywords: ["wiki", "memory", "knowledge", "notes", "reading", "book", "journal"] },
  { key: "user-circle", keywords: ["profile", "personal", "preference", "preferences", "lifestyle", "habit", "goal", "goals"] },
  { key: "file-text", keywords: ["document", "documents", "contract", "legal", "policy", "archive", "record", "records"] },
];

function tokenize(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  const joined: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const lowered = part.trim().toLowerCase();
    if (!lowered) continue;
    joined.push(lowered.replace(/[-\s]+/g, "_"));
    for (const token of lowered.split(/[^a-z0-9]+/)) {
      if (token) tokens.add(token);
    }
  }
  const haystack = joined.join(" ");
  for (const rule of SEMANTIC_RULES) {
    for (const kw of rule.keywords) {
      if (kw.includes("_") && haystack.includes(kw)) tokens.add(kw);
    }
  }
  return tokens;
}

export function resolveScopePhosphorIcon(input: {
  iconName?: string | null;
  domain?: string | null;
  label?: string | null;
  description?: string | null;
  pathSegments?: readonly string[];
}): ResolvedScopeIcon {
  const cleaned = (input.iconName ?? "").trim().toLowerCase();
  if (cleaned && cleaned !== "folder" && cleaned !== "folder-simple" && cleaned !== "sparkles") {
    const hit = ICON_REGISTRY[cleaned];
    if (hit) return { ...hit, iconKey: cleaned };
  }

  const specificTokens = tokenize(input.label, input.description, ...(input.pathSegments ?? []));
  const domainTokens = tokenize(input.domain);

  let bestKey: string | null = null;
  let bestScore = 0;
  for (const rule of SEMANTIC_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (specificTokens.has(kw)) score += 3;
      if (domainTokens.has(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestKey = rule.key;
    }
  }

  if (bestKey && ICON_REGISTRY[bestKey]) {
    return { ...ICON_REGISTRY[bestKey]!, iconKey: bestKey };
  }
  return { ...ICON_REGISTRY["folder-simple"]!, iconKey: "folder-simple" };
}
