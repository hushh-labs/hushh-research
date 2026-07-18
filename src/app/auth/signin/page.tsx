"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { Shield } from "lucide-react";

export default function SignIn() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  const handleSignIn = async (provider: "google" | "github") => {
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setError(error.message);
      }
    } catch (err) {
      setError("An error occurred during sign in");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        {/* Card Container */}
        <div className="rounded-2xl border border-border-subtle bg-surface-raised p-8 space-y-8">
          {/* Logo Section */}
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-green-dim border border-accent-green/20">
              <Shield className="h-6 w-6 text-accent-green" />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-text-primary">Hussh</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Privacy Trust Dashboard
              </p>
            </div>
          </div>

          {/* Description */}
          <div className="text-center space-y-2">
            <h2 className="text-lg font-semibold text-text-primary">
              Welcome Back
            </h2>
            <p className="text-sm text-text-secondary">
              Sign in to manage your privacy trust score and control connected
              services.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Sign In Buttons */}
          <div className="space-y-3">
            {/* GitHub Button */}
            <button
              onClick={() => handleSignIn("github")}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-overlay hover:bg-surface-raised px-4 py-3 text-sm font-medium text-text-primary transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className="h-4 w-4"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.868-.013-1.703-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.544 2.914 1.19.092-.926.35-1.546.636-1.902-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0110 4.817a9.59 9.59 0 012.5.336c1.909-1.294 2.747-1.025 2.747-1.025.545 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.138 18.163 20 14.413 20 10c0-5.523-4.477-10-10-10z"
                  clipRule="evenodd"
                />
              </svg>
              Continue with GitHub
            </button>

            {/* Google Button */}
            <button
              onClick={() => handleSignIn("google")}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-overlay hover:bg-surface-raised px-4 py-3 text-sm font-medium text-text-primary transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
              >
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </button>
          </div>

          {/* Footer */}
          <div className="text-center">
            <p className="text-xs text-text-muted">
              By signing in, you agree to our Privacy Policy. We never store
              your personal data.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
