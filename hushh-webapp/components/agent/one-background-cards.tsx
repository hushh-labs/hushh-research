"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import {
  ProfileResearchCard,
  type ProfileResearchAvailability,
} from "@/components/agent/profile-research-card";
import { Button } from "@/lib/morphy-ux/button";
import { MagicIntelligenceOffer } from "./magic-intelligence-offer";
import { unwindBackLayer, useBackLayer } from "@/lib/navigation/back-layers";

type Props = {
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  tokenExpiresAt: number | null;
  enabled: boolean;
  pathname: string;
  renderMessage: (id: string, text: string, card: ReactNode) => ReactNode;
  onVisibleChange?: (visible: boolean) => void;
  dismissedBusinessUids?: ReadonlySet<string>;
  onBusinessSaved?: (businessUid: string) => void;
};

/** One Magic offer; optional Business reviews retain their own confirmed writer. */
export function OneBackgroundCards(props: Props) {
  const authority = useMemo(
    () => ({
      ownerId: props.ownerId,
      key: props.vaultKey,
      token: props.vaultOwnerToken,
      enabled: props.enabled,
    }),
    [props.ownerId, props.vaultKey, props.vaultOwnerToken, props.enabled],
  );
  const [availability, setAvailability] = useState<{
    authority: typeof authority;
    profile: ProfileResearchAvailability;
    business: boolean;
    publicBusiness: boolean;
  } | null>(null);
  const [expandedFor, setExpandedFor] = useState<typeof authority | null>(null);
  const [businessExpandedFor, setBusinessExpandedFor] = useState<
    typeof authority | null
  >(null);
  const expanded = expandedFor === authority;
  const businessExpanded = expanded && businessExpandedFor === authority;
  const profile =
    availability?.authority === authority ? availability.profile : "hidden";
  const business =
    availability?.authority === authority &&
    (availability.business || availability.publicBusiness);
  const visible =
    props.enabled &&
    !!props.ownerId &&
    !!props.vaultKey &&
    !!props.vaultOwnerToken &&
    profile !== "saved" &&
    profile !== "pending" &&
    profile !== "low_confidence" &&
    profile !== "exhausted" &&
    (profile !== "hidden" || business);
  const onProfileAvailability = useCallback(
    (profile: ProfileResearchAvailability) => {
      setAvailability((current) => ({
        authority,
        profile,
        business: current?.authority === authority && current.business,
        publicBusiness:
          current?.authority === authority && current.publicBusiness,
      }));
    },
    [authority],
  );
  const onBusinessAvailability = useCallback(
    (business: boolean) => {
      setAvailability((current) => ({
        authority,
        business,
        profile: current?.authority === authority ? current.profile : "hidden",
        publicBusiness:
          current?.authority === authority && current.publicBusiness,
      }));
    },
    [authority],
  );
  const onPublicBusinessAvailability = useCallback(
    (publicBusiness: boolean) => {
      setAvailability((current) => ({
        authority,
        publicBusiness,
        profile: current?.authority === authority ? current.profile : "hidden",
        business: current?.authority === authority && current.business,
      }));
    },
    [authority],
  );
  const { onVisibleChange } = props;
  useEffect(() => {
    // The chat's starter tiles yield to the whole offer, including personal-only findings.
    onVisibleChange?.(Boolean(visible));
    return () => onVisibleChange?.(false);
  }, [onVisibleChange, visible]);
  useBackLayer(
    props.pathname,
    visible && expanded ? 1 : 0,
    useCallback(() => {
      setExpandedFor(null);
      setBusinessExpandedFor(null);
      return true;
    }, []),
  );
  useBackLayer(
    props.pathname,
    visible && businessExpanded ? 2 : 0,
    useCallback(() => {
      setBusinessExpandedFor(null);
      return true;
    }, []),
  );
  const details = (
    <>
      <ProfileResearchCard
        ownerId={props.ownerId}
        vaultKey={props.vaultKey}
        vaultOwnerToken={props.vaultOwnerToken}
        enabled={props.enabled}
        pathname={props.pathname}
        embedded
        present={expanded}
        onAvailabilityChange={onProfileAvailability}
        onBusinessAvailabilityChange={onPublicBusinessAvailability}
        renderMessage={(personal, businessFacts) => (
          <>
            {personal}
            <div hidden={!expanded || !business}>
              <Button
                variant="none"
                size="compact"
                aria-expanded={businessExpanded}
                onClick={() =>
                  businessExpanded
                    ? unwindBackLayer(props.pathname)
                    : setBusinessExpandedFor(authority)
                }
              >
                Business
              </Button>
              <div hidden={!businessExpanded}>{businessFacts}</div>
              <BusinessProfileSuggestion
                ownerId={props.ownerId}
                vaultKey={props.vaultKey}
                vaultOwnerToken={props.vaultOwnerToken}
                tokenExpiresAt={props.tokenExpiresAt}
                enabled={props.enabled}
                embedded
                present={businessExpanded}
                pathname={props.pathname}
                onVisibleChange={onBusinessAvailability}
                dismissedBusinessUids={props.dismissedBusinessUids}
                onSaved={props.onBusinessSaved}
              />
            </div>
          </>
        )}
      />
    </>
  );
  // Keep both controllers mounted while collapsed. Opening only reveals their
  // drafts; it never runs preparation or combines their save authorities.
  const card = (
    <MagicIntelligenceOffer
      profile={profile}
      businessAvailable={business}
      expanded={expanded}
      onReview={() => setExpandedFor(authority)}
      onBack={() => unwindBackLayer(props.pathname)}
    >
      {details}
    </MagicIntelligenceOffer>
  );
  return (
    <div hidden={!visible}>
      {props.renderMessage("magic-intelligence", "", card)}
    </div>
  );
}
