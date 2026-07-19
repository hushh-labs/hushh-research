"use client";

import { useState } from "react";
import {
  Camera as CameraIcon,
  ImagePlus,
  Loader2,
  Trash2,
  User as UserIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";
import { pickAvatarDataUrl } from "@/lib/profile/avatar-capture";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { isNative } from "@/lib/capacitor/platform";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";

function initialsOf(name?: string | null): string | null {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  return trimmed
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * The current user's profile avatar with an in-place "change photo" flow.
 * Renders the effective (custom-or-Firebase) photo, and on tap opens an action
 * sheet to upload a new one (native camera/library or web file picker) or
 * revert to the default. Write-through updates every avatar surface at once.
 */
export function ProfileAvatarEditor() {
  const { user } = useAuth();
  const photo = useEffectiveAvatarUrl();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const displayName = user?.displayName || null;
  const fallback = initialsOf(displayName);

  const handleChange = async () => {
    setSheetOpen(false);
    if (!user) return;
    try {
      const dataUrl = await pickAvatarDataUrl();
      if (!dataUrl) return; // user cancelled
      setBusy(true);
      await AccountIdentityService.uploadAvatar(user, dataUrl);
      toast.success("Profile photo updated");
    } catch (error) {
      toast.error("Could not update photo", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setSheetOpen(false);
    if (!user) return;
    setBusy(true);
    try {
      await AccountIdentityService.removeAvatar(user);
      toast.success("Profile photo removed");
    } catch (error) {
      toast.error("Could not remove photo", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const rowClass =
    "flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-[15px] font-medium text-foreground transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-50";

  return (
    <>
      <button
        type="button"
        data-profile-avatar-frame="true"
        onClick={() => setSheetOpen(true)}
        disabled={busy}
        aria-label="Change profile photo"
        className="group relative h-14 w-14 shrink-0 rounded-full bg-primary/18 p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:h-16 sm:w-16"
      >
        {photo ? (
          <Avatar className="h-full w-full">
            <AvatarImage src={photo} alt={displayName || "Profile"} />
            <AvatarFallback className="bg-muted p-2 text-base font-semibold text-muted-foreground sm:text-lg">
              {fallback ?? <UserIcon className="h-8 w-8 sm:h-9 sm:w-9" />}
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-full bg-muted p-2 text-base font-semibold text-muted-foreground sm:text-lg">
            {fallback ?? <UserIcon className="h-8 w-8 sm:h-9 sm:w-9" />}
          </div>
        )}
        <span
          className={cn(
            "absolute right-0 bottom-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background",
          )}
          aria-hidden="true"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CameraIcon className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>Profile photo</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-2 pb-3">
            <button type="button" onClick={handleChange} className={rowClass}>
              <ImagePlus className="h-5 w-5 text-primary" />
              {isNative() ? "Take photo or choose from library" : "Upload a photo"}
            </button>
            {photo ? (
              <button
                type="button"
                onClick={handleRemove}
                className={cn(rowClass, "text-destructive")}
              >
                <Trash2 className="h-5 w-5" />
                Remove photo
              </button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
