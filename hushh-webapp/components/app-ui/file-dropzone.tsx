"use client";

import * as React from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface FileDropzoneProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  onFileSelect?: (file: File) => void;
}

/**
 * Accessible File Dropzone
 * Provides a large, styled drag-and-drop area for document uploads (e.g., KYC files).
 * Hides the ugly native file input visually while maintaining perfect keyboard and screen reader access.
 */
export function FileDropzone({
  label = "Upload document",
  description = "Drag and drop a file, or click to browse",
  onFileSelect,
  className,
  ...props
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && onFileSelect) {
      onFileSelect(droppedFile);
    }
  }, [onFileSelect]);

  const handleChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && onFileSelect) {
      onFileSelect(selectedFile);
    }
  }, [onFileSelect]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200",
        isDragging
          ? "border-primary bg-primary/5"
          : "border-border/60 bg-muted/10 hover:bg-muted/20 hover:border-border",
        // A11y: Pass the focus ring to the outer container when the hidden input receives keyboard focus
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        className
      )}
    >
      {/* Native file input, hidden visually but accessible to screen readers and keyboards */}
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={handleChange}
        aria-label={label}
        {...props}
      />
      
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
        <UploadCloud 
          className={cn("size-6 transition-transform", isDragging && "scale-110 text-primary")} 
          aria-hidden="true" 
        />
      </div>
      <h3 className="text-base font-semibold tracking-tight text-foreground">{label}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}