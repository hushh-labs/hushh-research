"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { isNative } from "@/lib/capacitor/platform";
import { installNativeGoogleOAuthReturn, updateNativeGoogleOAuthAuth } from "@/lib/google/native-google-oauth";

/** App-level transport adapter; codes never enter the internal navigation URL. */
export function NativeGoogleOAuthReturn() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!isNative()) return;
    void installNativeGoogleOAuthReturn((destination) => router.replace(destination)).catch(() => {});
  }, [router]);
  useEffect(() => {
    if (isNative()) updateNativeGoogleOAuthAuth(user, loading);
  }, [user, loading]);
  useEffect(() => () => {
    if (isNative()) updateNativeGoogleOAuthAuth(null, false);
  }, []);
  return null;
}
