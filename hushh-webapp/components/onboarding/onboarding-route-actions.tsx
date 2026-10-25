"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, DotsThreeIcon as MoreHorizontal, TrashIcon as Trash2 } from "@/components/icons";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ROUTES } from "@/lib/navigation/routes";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { AccountCloudCleanup } from "@/components/profile/account-cloud-cleanup";
import { useCloudRemovalControl } from "@/components/profile/cloud-removal-control";
import { accountCleanupProvider } from "@/lib/services/account-cloud-cleanup";
import { buildLoginRouteWithAuthSessionNotice } from "@/lib/auth/session-invalidation";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DELETE_ACCOUNT_DIALOG_DESCRIPTION,
  DELETE_ACCOUNT_DIALOG_TITLE,
  accountDeletionErrorMessage,
  executeVerifiedAccountDeletion,
  isHandledAccountDeletionOutcome,
  resolveDeleteAccountAuth,
} from "@/lib/flows/delete-account";

/* ── OnboardingRouteActions ────────────────────────────────────────── */
export function OnboardingRouteActions() {
  const router = useRouter();
  const { user, userId, signOut } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [vaultUnlockOpen, setVaultUnlockOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cloudCleanupProvider, setCloudCleanupProvider] = useState<"azure" | "gcp" | null>(null);
  const cloudCleanupRequired = cloudCleanupProvider !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const cloudRemoval = useCloudRemovalControl({ menuOpen });
  const deletionRunning = useRef(false);

  async function handleSignOut() {
    try {
      await signOut();
      router.push(ROUTES.HOME);
    } catch (error) {
      console.error("[TopAppBar] Failed to sign out:", error);
      toast.error("Couldn't sign out. Please retry.");
    }
  }

  async function requestDeleteAccount() {
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (!user || !owner || owner.firebaseUid !== user.uid || owner.ownerId !== userId) return;

    try {
      const resolution = await resolveDeleteAccountAuth({
        userId: owner.ownerId,
        owner,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });

      if (resolution.kind === "needs_unlock") {
        setVaultUnlockOpen(true);
        return;
      }
    } catch (error) {
      console.error("[TopAppBar] Failed to prepare account deletion:", error);
      morphyToast.error("Failed to delete account. Please try again.");
      return;
    }

    setDeleteConfirmOpen(true);
  }

  async function handleDeleteAccount() {
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (!user || !owner || owner.firebaseUid !== user.uid || owner.ownerId !== userId || deletionRunning.current) return;

    deletionRunning.current = true;
    setIsDeleting(true);
    let needsCloudReview: "azure" | "gcp" | null = null;
    try {
      const resolution = await resolveDeleteAccountAuth({
        userId: owner.ownerId,
        owner,
        existingVaultOwnerToken: vaultOwnerToken ?? null,
      });

      if (resolution.kind === "needs_unlock") {
        setDeleteConfirmOpen(false);
        setVaultUnlockOpen(true);
        return;
      }

      await morphyToast
        .promise(
          executeVerifiedAccountDeletion({
            userId: owner.ownerId,
            owner,
            vaultOwnerToken: resolution.token,
            sessionUser: user,
            vaultKey,
          }),
          {
            loading: "Deleting your account...",
            success: "Account deleted.",
            error: accountDeletionErrorMessage,
            variant: "destructive",
          },
        )
        .unwrap();

      if (isValidatedAuthSessionOwnerCurrent(owner)) await signOut({
        redirectTo: buildLoginRouteWithAuthSessionNotice("account_deleted"),
        expectedUserId: owner.ownerId,
        skipFcmCleanup: true,
      });
    } catch (error) {
      needsCloudReview = accountCleanupProvider(error);
      if (needsCloudReview && isValidatedAuthSessionOwnerCurrent(owner)) setCloudCleanupProvider(needsCloudReview);
      (isHandledAccountDeletionOutcome(error) ? console.warn : console.error)(
        "[TopAppBar] Failed to delete account:",
        error,
      );
    } finally {
      deletionRunning.current = false;
      setIsDeleting(false);
      if (!needsCloudReview) setDeleteConfirmOpen(false);
    }
  }

  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <ShellActionSurface variant="icon" aria-label="Account actions">
            <MoreHorizontal className="h-5 w-5 text-current" />
          </ShellActionSurface>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="overflow-hidden rounded-[14px] p-1"
        >
          {cloudRemoval.action}
          <DropdownMenuItem
            onClick={() => void handleSignOut()}
            className="cursor-pointer rounded-[10px] hover:!bg-[color:var(--app-accent)] hover:!text-[color:var(--app-accent-fg)] hover:[&_svg]:!stroke-[color:var(--app-accent-fg)] hover:[&_svg]:!text-[color:var(--app-accent-fg)] focus:!bg-[color:var(--app-accent)] focus:!text-[color:var(--app-accent-fg)] focus:[&_svg]:!stroke-[color:var(--app-accent-fg)] focus:[&_svg]:!text-[color:var(--app-accent-fg)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
          >
            <LogOut className="h-4 w-4 text-current" />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => void requestDeleteAccount()}
            className="cursor-pointer rounded-[10px] hover:!bg-[color:var(--app-destructive-tint)] hover:!text-destructive focus:!bg-[color:var(--app-destructive-tint)] focus:!text-destructive focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-destructive)]"
          >
            <Trash2 className="h-4 w-4 text-current" />
            Delete account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {cloudRemoval.dialogs}

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultUnlockOpen}
          onOpenChange={setVaultUnlockOpen}
          title="Unlock Vault to Delete Account"
          description="Unlock your Vault to confirm account deletion. This permanent action removes your saved Vault information."
          onSuccess={() => {
            setVaultUnlockOpen(false);
            window.setTimeout(() => void requestDeleteAccount(), 300);
          }}
        />
      ) : null}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>{DELETE_ACCOUNT_DIALOG_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              {cloudCleanupRequired
                ? "Cloud cleanup is required before account deletion."
                : DELETE_ACCOUNT_DIALOG_DESCRIPTION}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cloudCleanupRequired && user && userId ? (
            <AccountCloudCleanup
              key={userId}
              userId={userId}
              token={vaultOwnerToken ?? null}
              provider={cloudCleanupProvider ?? undefined}
              purpose={cloudCleanupProvider === "gcp" ? "remove_cloud" : "account"}
              continueAccountDeletion={cloudCleanupProvider === "gcp"}
              onUnlock={() => {
                setDeleteConfirmOpen(false);
                setVaultUnlockOpen(true);
              }}
              onFinish={handleDeleteAccount}
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!isDeleting) void handleDeleteAccount();
              }}
              variant="destructive"
              disabled={isDeleting || cloudCleanupRequired}
              hidden={cloudCleanupRequired}
            >
              {isDeleting ? "Deleting..." : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
