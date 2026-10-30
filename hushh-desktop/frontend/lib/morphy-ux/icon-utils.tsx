"use client";

import React from "react";
import { useIconWeight } from "./icon-theme-context";
import { type IconWeight } from "@phosphor-icons/react";

// Utility component that automatically applies the global icon weight
export const IconWrapper: React.FC<{
  icon: React.ComponentType<{ className?: string; weight?: IconWeight }>;
  className?: string;
  weight?: IconWeight; // Optional override
}> = ({ icon: Icon, className, weight: overrideWeight }) => {
  const globalWeight = useIconWeight();
  const finalWeight = overrideWeight || globalWeight;

  return <Icon className={className} weight={finalWeight} />;
};

// Hook to get the current icon weight for manual usage
export const useGlobalIconWeight = () => {
  return useIconWeight();
};
