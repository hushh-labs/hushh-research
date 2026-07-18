"use client";

/** A single fixed Foundation canvas behind every application surface. */
export function FoundationPublicAmbient() {
  return (
    <div
      aria-hidden
      data-foundation-canvas="true"
      data-testid="foundation-canvas"
      className="foundation-public-ambient pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <div className="one-grain absolute inset-0" />
    </div>
  );
}
