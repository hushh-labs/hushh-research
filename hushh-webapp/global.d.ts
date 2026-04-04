/**
 * Global type declarations for custom elements
 * This file is referenced by triple-slash directive in material-ripple.tsx
 */

/// <reference types="react" />

interface MdRipple extends HTMLElement {
  disabled: boolean;
}

declare namespace JSX {
  interface IntrinsicElements {
    "md-ripple": React.DetailedHTMLProps<
      React.HTMLAttributes<MdRipple>,
      MdRipple
    > & {
      disabled?: boolean;
    };
  }
}
