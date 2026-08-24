import type { ComponentType } from "react";

/**
 * Render-site type for `as`-prop (polymorphic) components.
 *
 * Why this exists: TypeScript resolves JSX on a generic `ElementType` through
 * `JSX.LibraryManagedAttributes<T, …>`, and that resolution degrades to
 * `never` once `JSX.IntrinsicElements` gets very large. `@react-three/fiber`
 * makes it very large — it globally augments the interface with every
 * three.js object:
 *
 *   declare module 'react' {
 *     namespace JSX { interface IntrinsicElements extends ThreeElements {} }
 *   }
 *
 * The augmentation is global and has no opt-out, so importing R3F anywhere in
 * the program turns every `<Component {...props} />` inside a polymorphic
 * wrapper into `Type 'string' is not assignable to type 'never'`, in files
 * that never touch 3D at all.
 *
 * Casting the tag to this type sidesteps that resolution. Deliberately a
 * TYPE, not a helper function: a function that returns a component would be
 * called during render, which `react-hooks/static-components` correctly reads
 * as creating a new component identity every render.
 *
 * The looseness stops at the JSX tag. Every component using this still
 * declares its public props as `Omit<ComponentPropsWithoutRef<T>, "as">`, so
 * callers keep full per-element checking.
 */
export type PolymorphicTag = ComponentType<Record<string, unknown>>;
