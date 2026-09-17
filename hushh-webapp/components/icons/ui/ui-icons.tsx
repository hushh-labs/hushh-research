"use client";

import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  ChatCircleDots,
  Copy,
  DotsThree,
  EnvelopeSimple,
  GearSix,
  Info,
  Key,
  Laptop,
  List,
  LockKey,
  MagnifyingGlass,
  Microphone,
  PaperPlaneRight,
  PencilSimple,
  Plus,
  SidebarSimple,
  SignOut,
  ShieldCheck,
  Sliders,
  Sparkle,
  SquaresFour,
  Trash,
  User,
  WarningCircle,
  X,
  type IconProps,
  type IconWeight,
} from "@phosphor-icons/react";

export type UiIconProps = IconProps & {
  size?: number | string;
  weight?: IconWeight;
};

export function MessageSquareIcon({ weight = "duotone", ...props }: UiIconProps) {
  return <ChatCircleDots weight={weight} {...props} />;
}

export function ShieldIcon({ weight = "duotone", ...props }: UiIconProps) {
  return <ShieldCheck weight={weight} {...props} />;
}

/**
 * 1. Search Icon
 * Phosphor MagnifyingGlass
 */
export function SearchIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <MagnifyingGlass
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

/**
 * 2. Grid View Icon
 * Phosphor SquaresFour
 */
export function GridIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <SquaresFour
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

/**
 * 3. List View Icon
 * Phosphor List
 */
export function ListIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <List
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { ListIcon as MenuIcon };

/**
 * 4. Caret / Chevron Navigation Icons
 * Phosphor CaretRight, CaretDown, CaretLeft, CaretUp
 */
export function CaretRightIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <CaretRight
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { CaretRightIcon as ChevronRightIcon };

export function CaretDownIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <CaretDown
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { CaretDownIcon as ChevronDownIcon };

export function CaretLeftIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <CaretLeft
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { CaretLeftIcon as ChevronLeftIcon };

export function CaretUpIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <CaretUp
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { CaretUpIcon as ChevronUpIcon };

/**
 * 5. Arrow Navigation Icons
 * Phosphor ArrowLeft, ArrowRight
 */
export function ArrowLeftIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <ArrowLeft
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function ArrowRightIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <ArrowRight
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

/**
 * 6. Action / Control Icons
 */
export function PlusIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Plus
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function XIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <X
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { XIcon as CloseIcon };

export function CheckIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Check
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function TrashIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Trash
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function PencilIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <PencilSimple
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function CopyIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Copy
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function SendIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <PaperPlaneRight
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function MicrophoneIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Microphone
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function SparkleIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Sparkle
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function GearIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <GearSix
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { GearIcon as SettingsIcon };

export function SlidersIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Sliders
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function DotsThreeIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <DotsThree
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
export { DotsThreeIcon as MoreHorizontalIcon };

export function ExternalLinkIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <ArrowSquareOut
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function PanelLeftCloseIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <SidebarSimple
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function PanelLeftOpenIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <SidebarSimple
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

/**
 * 7. System, Security & Status Icons
 */
export function LockIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <LockKey
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function UserIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <User
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function LaptopIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Laptop
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function KeyIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Key
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function MailIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <EnvelopeSimple
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function InfoIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <Info
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function AlertCircleIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <WarningCircle
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}

export function LogOutIcon({
  size = "1em",
  weight = "duotone",
  className,
  ...props
}: UiIconProps) {
  return (
    <SignOut
      size={size}
      weight={weight}
      className={className}
      {...props}
    />
  );
}
