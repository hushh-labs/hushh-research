/**
 * Session API Endpoint
 * =====================
 *
 * POST: Create a new session (set httpOnly cookie)
 * DELETE: Destroy session (clear cookie)
 *
 * This endpoint handles secure session management using
 * Firebase Admin SDK to create httpOnly session cookies.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSessionCookie, verifySessionCookie } from "@/lib/firebase/admin";

// Session cookie name
const SESSION_COOKIE_NAME = "hushh_session";

// Session duration: 5 days in milliseconds
const SESSION_DURATION = 5 * 24 * 60 * 60 * 1000;

/**
 * POST /api/auth/session
 * Create a new session from a Firebase ID token
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { idToken } = body;

    if (!idToken) {
      return NextResponse.json(
        { error: "ID token is required" },
        { status: 400 }
      );
    }

    // Create session cookie using Firebase Admin SDK
    const { success, sessionCookie } = await createSessionCookie(
      idToken,
      SESSION_DURATION
    );

    if (!success || !sessionCookie) {
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 401 }
      );
    }

    // Set the httpOnly cookie
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_DURATION / 1000, // Convert to seconds
      path: "/",
    });

    return NextResponse.json({
      success: true,
      message: "Session created successfully",
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
  console.error("[Session API] Error creating session:", error);
}
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/auth/session
 * Destroy the current session
 */
export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE_NAME);

    return NextResponse.json({
      success: true,
      message: "Session destroyed",
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
  console.error("[Session API] Error destroying session:", error);
}
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/auth/session
 * Verify current session
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (!sessionCookie?.value) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    const { valid, uid } = await verifySessionCookie(sessionCookie.value);

    if (!valid) {
      // Clear invalid cookie
      cookieStore.delete(SESSION_COOKIE_NAME);
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      uid,
    });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[Session API] Error verifying session:", error);
    }
    return NextResponse.json(
      { authenticated: false, error: "Verification failed" },
      { status: 500 } 
    );
  }
}
