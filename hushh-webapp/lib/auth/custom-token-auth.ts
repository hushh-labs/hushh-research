import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import { inMemoryPersistence, setPersistence, signInWithCustomToken } from "firebase/auth";
import type { User } from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import type { AuthResult } from "@/lib/services/auth-service";

type NativeUser = NonNullable<Awaited<ReturnType<typeof FirebaseAuthentication.signInWithCustomToken>>["user"]>;

export async function authenticateCustomToken(
  token: string,
  options: { memoryOnly?: boolean },
  fromNative: (user: NativeUser, idToken: string) => User,
): Promise<AuthResult> {
  if (Capacitor.isNativePlatform()) {
    if (options.memoryOnly) throw new Error("Memory-only reviewer authentication requires web.");
    const result = await FirebaseAuthentication.signInWithCustomToken({ token });
    if (!result.user) throw new Error("Native custom-token login returned no user");
    const idToken = (await FirebaseAuthentication.getIdToken()).token || "";
    if (!idToken) throw new Error("Native custom-token login returned no ID token");
    return { user: fromNative(result.user, idToken), idToken };
  }
  if (options.memoryOnly) await setPersistence(auth, inMemoryPersistence);
  const result = await signInWithCustomToken(auth, token);
  return { user: result.user, idToken: await result.user.getIdToken() };
}
