import type * as React from "react";

interface MdRipple extends HTMLElement {
  disabled: boolean;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "md-ripple": React.DetailedHTMLProps<React.HTMLAttributes<MdRipple>, MdRipple> & {
        disabled?: boolean;
      };
      "capacitor-google-map": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {};
