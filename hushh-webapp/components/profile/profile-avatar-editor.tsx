"use client";

import { useState } from "react";
import Image from "next/image";
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
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  const displayName = user?.displayName || null;
  const fallback = initialsOf(displayName);
  const shownPhoto = previewPhoto ?? photo;

  const handleChange = async () => {
    setSheetOpen(false);
    if (!user || busy) return;
    let dataUrl: string | null = null;
    try {
      dataUrl = await pickAvatarDataUrl();
    } catch {
      toast.error("Could not update photo");
      return;
    }
    if (!dataUrl) return; // user cancelled

    setPreviewPhoto(dataUrl);
    setBusy(true);
    const upload = AccountIdentityService.uploadAvatar(user, dataUrl);
    toast.promise(upload, {
      loading: "Updating photo...",
      success: "Profile photo updated.",
      error: (error) =>
        error instanceof Error ? error.message : "Could not update photo.",
    });
    try {
      await upload;
    } catch {
      setPreviewPhoto(null);
    } finally {
      setBusy(false);
      setPreviewPhoto(null);
    }
  };

  const handleRemove = async () => {
    setSheetOpen(false);
    if (!user || busy) return;
    setBusy(true);
    const removal = AccountIdentityService.removeAvatar(user);
    toast.promise(removal, {
      loading: "Removing photo...",
      success: "Profile photo removed.",
      error: (error) =>
        error instanceof Error ? error.message : "Could not remove photo.",
    });
    try {
      await removal;
    } catch {
      // The morphing toast owns the user-facing error state.
    } finally {
      setBusy(false);
    }
  };

  const rowClass =
    "flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-[15px] font-medium text-foreground transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-50";

  return (
    <>
      <div
        data-profile-avatar-frame="true"
        aria-busy={busy}
        className="relative h-14 w-14 shrink-0 rounded-full bg-primary/18 p-1 sm:h-16 sm:w-16"
      >
        <button
          type="button"
          data-profile-avatar-display="true"
          onClick={() => setSheetOpen(true)}
          disabled={busy}
          aria-label="Profile photo options"
          className="group flex h-full w-full items-center justify-center rounded-full outline-none transition duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default"
        >
          {shownPhoto ? (
            <Avatar className="h-full w-full">
              {previewPhoto ? (
                // A just-picked data URL should appear immediately; the shared
                // AvatarImage waits for image-load state before replacing the fallback.
                <Image
                  src={previewPhoto}
                  alt={displayName || "Profile"}
                  data-slot="avatar-image"
                  fill
                  sizes="96px"
                  unoptimized
                  className="object-cover"
                />
              ) : (
                <AvatarImage src={shownPhoto} alt={displayName || "Profile"} />
              )}
              <AvatarFallback className="bg-muted p-2 text-base font-semibold text-muted-foreground sm:text-lg">
                {fallback ?? <UserIcon className="h-8 w-8 sm:h-9 sm:w-9" />}
              </AvatarFallback>
            </Avatar>
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-full bg-muted p-2 text-base font-semibold text-muted-foreground sm:text-lg">
              {fallback ?? <UserIcon className="h-8 w-8 sm:h-9 sm:w-9" />}
            </div>
          )}
        </button>
        <button
          type="button"
          data-profile-avatar-camera="true"
          onClick={handleChange}
          disabled={busy}
          aria-label="Change profile photo"
          className={cn(
            "absolute right-0 bottom-0 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-95 disabled:cursor-default",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CameraIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>Profile photo</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <button type="button" onClick={handleChange} className={rowClass}>
              <ImagePlus className="h-5 w-5 text-primary" />
              {isNative() ? "Take photo or choose from library" : "Upload a photo"}
            </button>
            {shownPhoto ? (
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
