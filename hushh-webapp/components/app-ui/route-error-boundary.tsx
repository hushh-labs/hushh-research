"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackRoute?: string;
  /**
   * Pass the current pathname (or any unique value) here.
   * If this key changes, the error boundary will automatically reset.
   */
  resetKey?: string | number;
  /** Optional callback to use Next.js/React Router soft navigation instead of hard reloads */
  onNavigate?: (path: string) => void;
  /** Optional callback triggered when the user clicks 'Try again' */
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Route-level error boundary for KAI/RIA layouts.
 * Catches render errors and shows a morphy-styled recovery UI.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "[RouteErrorBoundary] Uncaught error:",
      error,
      errorInfo.componentStack,
    );
  }

  // Automatically reset the error state if the user navigates away via an external layout link
  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  private handleRetry = () => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  private handleGoHome = () => {
    const targetRoute = this.props.fallbackRoute ?? "/";

    if (this.props.onNavigate) {
      // Soft navigation via router
      this.props.onNavigate(targetRoute);
      this.setState({ hasError: false, error: null });
    } else {
      // Fallback to hard reload
      window.location.href = targetRoute;
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-6">
          <Card
            preset="default"
            effect="glass"
            glassAccent="soft"
            className="mx-auto w-full max-w-sm text-center"
          >
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500/12 to-orange-500/12 dark:from-red-400/16 dark:to-orange-400/16">
                <AlertTriangle className="h-7 w-7 text-red-500 dark:text-red-400" />
              </div>

              <div className="space-y-1.5 w-full">
                <h2 className="text-lg font-semibold tracking-tight">Something went wrong</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  An unexpected error occurred. You can try again or return to the home screen.
                </p>

                {/* Developer Experience Enhancement: Show error message locally */}
                {process.env.NODE_ENV === "development" && this.state.error && (
                  <div className="mt-4 rounded-md bg-red-500/10 p-3 text-left text-xs text-red-600 dark:bg-red-500/20 dark:text-red-400 overflow-auto max-h-32">
                    <p className="font-mono">{this.state.error.message}</p>
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-1">
                <Button
                  variant="muted"
                  effect="glass"
                  size="sm"
                  onClick={this.handleRetry}
                >
                  Try again
                </Button>
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="sm"
                  onClick={this.handleGoHome}
                >
                  Go home
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}