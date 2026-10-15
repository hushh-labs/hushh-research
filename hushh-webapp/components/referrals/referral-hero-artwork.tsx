"use client";

import Image from "next/image";

export const REFERRAL_HERO_ARTWORK_SRC = "/referrals/hussh-referral-mascot.svg";

/** Original high-resolution pixels, losslessly compressed inside the SVG asset. */
export function ReferralHeroArtworkSvg({
  paused = false,
  source = REFERRAL_HERO_ARTWORK_SRC,
}: {
  paused?: boolean;
  source?: string;
}) {
  return (
    <Image
      src={source}
      alt=""
      width={1124}
      height={887}
      unoptimized
      loading="eager"
      fetchPriority="high"
      className="referral-hero-art"
      data-paused={paused}
      aria-hidden="true"
    />
  );
}

export function ReferralHeroArtwork({ active }: { active: boolean }) {
  return <ReferralHeroArtworkSvg paused={!active} />;
}
