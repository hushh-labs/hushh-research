"use client";

/**
 * Morphy-UX Sidebar Menu Button
 *
 * Material 3 Expressive ripple effect with state layer mechanics.
 * Uses @material/web <md-ripple> for authentic physics.
 *
 * Usage:
 * <SidebarMenuButton href="/path" isActive={isActive}>
 *   <Icon className="h-4 w-4" />
 *   <span>Label</span>
 * </SidebarMenuButton>
 */

import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { useSidebar } from "@/components/ui/sidebar";

// ============================================================================
// SIDEBAR MENU BUTTON VARIANTS
// ============================================================================

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding,background] hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 relative cursor-pointer",
  {
    variants: {
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

// ============================================================================
// SIDEBAR MENU BUTTON COMPONENT
// ============================================================================

export interface SidebarMenuButtonProps
  extends VariantProps<typeof sidebarMenuButtonVariants> {
  href: string;
  isActive?: boolean;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}

const SidebarMenuButton = React.forwardRef<
  HTMLAnchorElement,
  SidebarMenuButtonProps
>(
  (
    { className, size = "default", isActive = false, href, children, onClick },
    ref
  ) => {
    const { isMobile, setOpenMobile } = useSidebar();

    const handleClick = () => {
      // Close mobile drawer on navigation
      if (isMobile) {
        setOpenMobile(false);
      }
      onClick?.();
    };

    return (
      <Link
        ref={ref}
        href={href}
        data-slot="morphy-sidebar-menu-button"
        data-size={size}
        data-active={isActive}
        className={cn(sidebarMenuButtonVariants({ size }), className)}
        onClick={handleClick}
      >
        {children}
        {/* Material 3 Expressive Ripple */}
        <MaterialRipple variant="link" effect="glass" />
      </Link>
    );
  }
);

SidebarMenuButton.displayName = "SidebarMenuButton";

export { SidebarMenuButton, sidebarMenuButtonVariants };
