import type { ButtonHTMLAttributes } from "react";
import { AddPeopleIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/** The SMS Circle text action, shared by member-picker entry points. */
export function AddPeopleAction({
  children = "Add people",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      data-slot="add-people-action"
      className={cn("group inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-lg bg-transparent px-1.5 py-1 text-[17px] font-medium leading-[22px] text-[color:var(--ios-account-label)] transition-colors hover:text-[color:var(--app-accent)] active:text-[color:var(--app-accent)] focus-visible:text-[color:var(--app-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--app-accent)] disabled:opacity-60", className)}
      {...props}
    >
      <AddPeopleIcon size={24} className="shrink-0 group-hover:text-[color:var(--app-accent)] group-active:text-[color:var(--app-accent)] group-focus-visible:text-[color:var(--app-accent)]" />
      <span>{children}</span>
    </button>
  );
}
