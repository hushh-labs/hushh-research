"use client";

import { ChevronDown } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MailboxScope } from "@/lib/mail/use-mailbox-scope";
import type { PrivateMailAccount } from "@/lib/services/private-google-connections";
import { MailActionButton } from "./mail-action-button";

export function MailboxSwitcher({
  scope,
  busy,
  onAdd,
  onReconnect,
  onDisconnect,
}: {
  scope: MailboxScope;
  busy: boolean;
  onAdd: () => void;
  onReconnect: (account: PrivateMailAccount) => void;
  onDisconnect: (account: PrivateMailAccount) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MailActionButton type="button" variant="ghost" aria-label="Choose mailbox" className="min-h-11 max-w-[min(42vw,18rem)] gap-1.5 px-2 text-sm">
          <span className="truncate">{scope.selectedId === "all" ? "All Mail" : scope.selected?.email || "Mailbox"}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </MailActionButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[min(86vw,25rem)]">
        <DropdownMenuRadioGroup value={scope.selectedId} onValueChange={scope.choose}>
          <DropdownMenuRadioItem value="all" className="min-h-11">All Mail</DropdownMenuRadioItem>
          {scope.accounts.filter((account) => account.capabilities.read).map((account) => (
            <DropdownMenuRadioItem key={account.accountId} value={account.accountId} className="min-h-11">
              <span className="truncate">{account.email || "Connected mailbox"}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {scope.accounts.filter((account) => account.status === "needs_reauth").map((account) => (
          <DropdownMenuItem key={account.accountId} className="min-h-11" disabled={busy} onSelect={() => onReconnect(account)}>
            <span className="truncate">Reconnect {account.email || "mailbox"}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11" disabled={busy} onSelect={onAdd}>Add mailbox</DropdownMenuItem>
        {scope.selected ? (
          <>
            <DropdownMenuItem className="min-h-11" disabled={busy} onSelect={() => onReconnect(scope.selected!)}>
              Reconnect selected mailbox
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" variant="destructive" disabled={busy} onSelect={() => onDisconnect(scope.selected!)}>
              Disconnect selected mailbox
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
