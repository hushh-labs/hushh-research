"use client";

import type { ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const TYPOGRAPHY_CLASSNAMES = {
  pageTitle: "ui-text-page-title",
  pageSubtitle: "ui-text-page-subtitle",
  navigationTitle: "ui-text-navigation-title",
  identityName: "ui-text-identity-name",
  majorSectionTitle: "ui-text-major-section-title",
  sectionLabel: "ui-text-section-label",
  cardTitle: "ui-text-card-title",
  rowLabel: "ui-text-row-label",
  rowLabelEmphasized: "ui-text-row-label-emphasized",
  rowDescription: "ui-text-row-description",
  trailingValue: "ui-text-trailing-value",
  trailingAction: "ui-text-trailing-action",
  formLabel: "ui-text-form-label",
  inputValue: "ui-text-input-value",
  helperText: "ui-text-helper-text",
  statusText: "ui-text-status",
  buttonLabel: "ui-text-button-label",
  tabLabel: "ui-text-tab-label",
  caption: "ui-text-caption",
  legal: "ui-text-legal",
} as const;

type RoleTextProps = {
  as?: ElementType;
  children?: ReactNode;
  className?: string;
  [key: string]: unknown;
};

function SemanticText({
  as: Component = "span",
  className,
  children,
  roleClassName,
  ...props
}: RoleTextProps & { roleClassName: string }) {
  return (
    <Component className={cn(roleClassName, className)} {...props}>
      {children}
    </Component>
  );
}

export function PageTitle({ as = "h1", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.pageTitle}
      {...props}
    />
  );
}

export function PageSubtitle({ as = "p", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.pageSubtitle}
      {...props}
    />
  );
}

export function NavigationTitle(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.navigationTitle}
      {...props}
    />
  );
}

export function IdentityName({ as = "h1", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.identityName}
      {...props}
    />
  );
}

export function MajorSectionTitle({ as = "h2", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.majorSectionTitle}
      {...props}
    />
  );
}

export function SectionLabel({ as = "div", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.sectionLabel}
      {...props}
    />
  );
}

export function CardTitle({ as = "h3", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.cardTitle}
      {...props}
    />
  );
}

export function RowLabel(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.rowLabel}
      {...props}
    />
  );
}

export function RowDescription({ as = "p", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.rowDescription}
      {...props}
    />
  );
}

export function TrailingValue(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.trailingValue}
      {...props}
    />
  );
}

export function TrailingAction(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.trailingAction}
      {...props}
    />
  );
}

export function FormLabel({ as = "label", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.formLabel}
      {...props}
    />
  );
}

export function HelperText({ as = "p", ...props }: RoleTextProps) {
  return (
    <SemanticText
      as={as}
      roleClassName={TYPOGRAPHY_CLASSNAMES.helperText}
      {...props}
    />
  );
}

export function InputValue(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.inputValue}
      {...props}
    />
  );
}

export function StatusText(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.statusText}
      {...props}
    />
  );
}

export function ButtonLabel(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.buttonLabel}
      {...props}
    />
  );
}

export function TabLabel(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.tabLabel}
      {...props}
    />
  );
}

export function CaptionText(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.caption}
      {...props}
    />
  );
}

export function LegalText(props: RoleTextProps) {
  return (
    <SemanticText
      roleClassName={TYPOGRAPHY_CLASSNAMES.legal}
      {...props}
    />
  );
}
