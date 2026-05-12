"use client";

import * as React from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface ProgressiveImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  // A11y: We override the native type to make 'alt' strictly required, not optional.
  alt: string; 
  fallbackIcon?: React.ReactNode;
}

/**
 * Accessible Progressive Image Loader
 * Prevents layout shift (CLS) by reserving space during load.
 * Features a smooth fade-in and graceful error handling for broken URLs.
 */
export function ProgressiveImage({
  src,
  alt,
  fallbackIcon,
  className,
  ...props
}: ProgressiveImageProps) {
  const [isLoading, setIsLoading] = React.useState(true);
  const [hasError, setHasError] = React.useState(false);

  return (
    <div className={cn("relative overflow-hidden bg-muted/10", className)}>
      {/* Skeleton Pulse State */}
      {isLoading && !hasError && (
        <div 
          className="absolute inset-0 animate-pulse bg-muted/40" 
          aria-hidden="true" 
        />
      )}

      {/* Error / Broken Link State */}
      {hasError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/20 text-muted-foreground">
          {fallbackIcon || <ImageOff className="size-6 opacity-40" aria-hidden="true" />}
          {/* A11y: Let screen readers know the image failed, but hide the text visually */}
          <span className="sr-only">Failed to load image: {alt}</span>
        </div>
      ) : (
        /* Actual Image */
        <img
          src={src}
          alt={alt}
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-500 ease-in-out",
            isLoading ? "opacity-0" : "opacity-100"
          )}
          {...props}
        />
      )}
    </div>
  );
}