"use client";

import * as React from "react";

import {
  Tabs as StockTabs,
  TabsContent as StockTabsContent,
  TabsList as StockTabsList,
  TabsTrigger as StockTabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof StockTabs>) {
  return <StockTabs className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof StockTabsList>) {
  return <StockTabsList className={cn("h-14 p-1", className)} {...props} />;
}

interface TabsTriggerProps extends React.ComponentProps<typeof StockTabsTrigger> {
  showRipple?: boolean;
}

function TabsTrigger({
  className,
  children,
  showRipple = true,
  ...props
}: TabsTriggerProps) {
  return (
    <StockTabsTrigger
      className={cn("relative isolate overflow-hidden", className)}
      {...props}
    >
      <span className="relative z-0 inline-flex items-center gap-1.5">{children}</span>
      {showRipple ? (
        <MaterialRipple variant="none" effect="fade" className="z-10" />
      ) : null}
    </StockTabsTrigger>
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof StockTabsContent>) {
  return <StockTabsContent className={cn("flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
