"use client";

import { ReactNode } from "react";

export default function Template({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {children}
    </div>
  );
}
