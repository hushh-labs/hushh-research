import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const secretKey =
  process.env.SESSION_SECRET ||
  "dev-secret-hushh-2025-secure-key-change-in-prod";
const key = new TextEncoder().encode(secretKey);

interface SessionPayload {
  userId: string;
  email?: string;
  name?: string;
  expiresAt: Date;
}

export async function encrypt(payload: SessionPayload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

export async function decrypt(session: string | undefined = "") {
  try {
    const { payload } = await jwtVerify(session, key, {
      algorithms: ["HS256"],
    });
    return payload;
  } catch (_error) {
    return null;
  }
}

export async function createSession(
  userId: string,
  email?: string,
  name?: string
) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await encrypt({ userId, email, name, expiresAt });

  const cookieStore = await cookies();
  cookieStore.set("user_session", session, {
    httpOnly: true,
    secure: true, // Always true for modern browsers/localhost
    expires: expiresAt,
    sameSite: "lax",
    path: "/",
  });
}

export async function verifySession() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get("user_session")?.value;
  const session = await decrypt(cookie);

  if (!session?.userId) {
    return null;
  }

  return {
    userId: session.userId as string,
    email: session.email as string | undefined,
    name: session.name as string | undefined,
  };
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete("user_session");
}
