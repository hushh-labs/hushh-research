"use client";

import {
  Bank,
  Wallet,
  MapPin,
  UsersThree,
  EnvelopeSimple,
  CalendarBlank,
  IdentificationCard,
  Graph,
  LockKey,
  Storefront,
  PlugsConnected,
  type IconProps,
  type IconWeight,
} from "@phosphor-icons/react";

export type AgentIconProps = IconProps & {
  size?: number | string;
  weight?: IconWeight;
};

/**
 * 1. Finance Agent Icon (Kai / Sovereign Wealth)
 * Base: Phosphor Bank
 */
export function FinanceAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#10B981",
  className,
  ...props
}: AgentIconProps) {
  return (
    <Bank
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 2. Wallet Agent Icon
 * Base: Phosphor Wallet
 */
export function WalletAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#F59E0B",
  className,
  ...props
}: AgentIconProps) {
  return (
    <Wallet
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 3. Location Agent Icon
 * Base: Phosphor MapPin
 */
export function LocationAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#EF4444",
  className,
  ...props
}: AgentIconProps) {
  return (
    <MapPin
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 4. RIA Agent Icon
 * Base: Phosphor UsersThree
 */
export function RiaAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#8B5CF6",
  className,
  ...props
}: AgentIconProps) {
  return (
    <UsersThree
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 5. Email (Gmail) Agent Icon
 * Base: Phosphor EnvelopeSimple
 */
export function GmailAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#E11D48",
  className,
  ...props
}: AgentIconProps) {
  return (
    <EnvelopeSimple
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 6. Calendar Agent Icon
 * Base: Phosphor CalendarBlank
 */
export function CalendarAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#0284C7",
  className,
  ...props
}: AgentIconProps) {
  return (
    <CalendarBlank
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 7. KYC / Identity Agent Icon
 * Base: Phosphor IdentificationCard
 */
export function KycAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#2563EB",
  className,
  ...props
}: AgentIconProps) {
  return (
    <IdentificationCard
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}
export { KycAgentIcon as EmailAgentIcon };

/**
 * 8. Memory / PKM Agent Icon
 * Base: Phosphor Graph
 */
export function MemoryAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#6366F1",
  className,
  ...props
}: AgentIconProps) {
  return (
    <Graph
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}
export { MemoryAgentIcon as PkmAgentIcon };

/**
 * 9. Consent / Vault Agent Icon
 * Base: Phosphor LockKey
 */
export function ConsentAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#F97316",
  className,
  ...props
}: AgentIconProps) {
  return (
    <LockKey
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 10. Marketplace Agent Icon
 * Base: Phosphor Storefront
 */
export function MarketplaceAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#059669",
  className,
  ...props
}: AgentIconProps) {
  return (
    <Storefront
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}

/**
 * 11. Connected Systems Agent Icon
 * Base: Phosphor PlugsConnected
 */
export function ConnectedSystemsAgentIcon({
  size = "1em",
  weight = "duotone",
  color = "#00E5FF",
  className,
  ...props
}: AgentIconProps) {
  return (
    <PlugsConnected
      size={size}
      weight={weight}
      color={color}
      className={className}
      {...props}
    />
  );
}
export { ConnectedSystemsAgentIcon as CrmAgentIcon };

export const AGENT_ICON_MAP = {
  finance: FinanceAgentIcon,
  wallet: WalletAgentIcon,
  location: LocationAgentIcon,
  ria: RiaAgentIcon,
  gmail: GmailAgentIcon,
  calendar: CalendarAgentIcon,
  email: KycAgentIcon,
  pkm: MemoryAgentIcon,
  consent: ConsentAgentIcon,
  marketplace: MarketplaceAgentIcon,
  "connected-systems": ConnectedSystemsAgentIcon,
} as const;

export type AgentIconKey = keyof typeof AGENT_ICON_MAP;
