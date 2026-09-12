"use client";

import React from "react";
import Image from "next/image";

export function OneArcIllustration() {
  return (
    <div className="relative mx-auto flex h-[245px] w-full max-w-[360px] items-center justify-center select-none overflow-visible py-1">
      {/* 3D Hero Illustration Image: Light mode asset on light theme, Dark mode asset on dark theme */}
      <div className="relative z-10 flex items-center justify-center w-full h-full">
        {/* Light Mode Asset */}
        <Image
          src="/one-auth-hero-light.png"
          alt="One Auth 3D Hero Illustration Light"
          width={876}
          height={1100}
          priority
          quality={100}
          unoptimized
          className="block dark:hidden h-auto max-h-[240px] w-auto max-w-[355px] object-contain"
        />

        {/* Dark Mode Asset */}
        <Image
          src="/one-auth-hero-dark.png"
          alt="One Auth 3D Hero Illustration Dark"
          width={1428}
          height={952}
          priority
          quality={100}
          unoptimized
          className="hidden dark:block h-auto max-h-[240px] w-auto max-w-[355px] object-contain"
        />
      </div>
    </div>
  );
}
