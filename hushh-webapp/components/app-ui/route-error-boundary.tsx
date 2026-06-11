"use client";

import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { AlertTriangle } from "lucide-react";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

interface Props {
  children: ReactNode;
  fallbackRoute?: string;
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
  private errorRef = createRef<HTMLDivElement>();

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidUpdate(_prevProps: Props, prevState: State) {
    if (this.state.hasError && !prevState.hasError) {
      this.errorRef.current?.focus();
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "[RouteErrorBoundary] Uncaught error:",
      error,
      errorInfo.componentStack,
    );
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleGoHome = () => {
    requestInternalAppNavigation({
      href: this.props.fallbackRoute ?? "/",
      replace: true,
      scroll: false,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          ref={this.errorRef}
          role="alert"
          tabIndex={-1}
          className="flex min-h-[60vh] flex-col items-center justify-center px-6 outline-none"
        >
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
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight">Something went wrong</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  An unexpected error occurred. You can try again or return to the home screen.
                </p>
              </div>
              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="muted"
                  effect="glass"
                  size="sm"
                  className="min-h-[44px]"
                  onClick={this.handleRetry}
                >
                  Try again
                </Button>
                <Button
                  type="button"
                  variant="blue-gradient"
                  effect="fill"
                  size="sm"
                  className="min-h-[44px]"
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
