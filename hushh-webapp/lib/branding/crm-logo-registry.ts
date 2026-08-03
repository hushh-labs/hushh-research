/**
 * Safe, public presentation metadata for configured CRM systems.
 *
 * Keep customer marks here rather than scattering asset paths through route
 * components. This is registry metadata only: it must never contain a record
 * identifier, field value, or other protected CRM information.
 */
export type CrmLogoAsset = {
  src: string;
  alt: string;
};

const CRM_LOGO_INVENTORY: ReadonlyArray<{
  matches: readonly string[];
  asset: CrmLogoAsset;
}> = [
  {
    matches: ["macy's", "macys", "macy"],
    asset: { src: "/brand/macys-logo.svg", alt: "Macy's logo" },
  },
  {
    matches: ["chase"],
    asset: { src: "/brand/chase-logo.svg", alt: "Chase logo" },
  },
];

/** Resolve a public customer mark from the CRM registry's display metadata. */
export function resolveCrmLogoAsset(
  system?: {
    customerDisplayName?: string | null;
    target?: string | null;
    displayName?: string | null;
  } | null,
): CrmLogoAsset | null {
  const values = [
    system?.customerDisplayName,
    system?.target,
    system?.displayName,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLocaleLowerCase(),
    )
    .filter(Boolean);

  return (
    CRM_LOGO_INVENTORY.find(({ matches }) =>
      values.some((value) => matches.some((match) => value.includes(match))),
    )?.asset ?? null
  );
}
