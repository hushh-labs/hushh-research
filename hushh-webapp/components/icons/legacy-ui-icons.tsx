"use client";

import * as Phosphor from "@phosphor-icons/react";
import { forwardRef } from "react";
import type { Icon, IconProps, IconWeight } from "@phosphor-icons/react";

/**
 * Compatibility facade for legacy component names. Every export renders the
 * equivalent official Phosphor icon. Capability aliases keep the canonical
 * duotone default; utility aliases opt into regular so they never paint a
 * secondary fill that reads like a background.
 * strokeWidth is accepted for source compatibility but intentionally ignored;
 * Phosphor owns the rendered geometry and weight.
 */
export type CanonicalIconProps = Omit<IconProps, "ref"> & {
  strokeWidth?: React.SVGProps<SVGSVGElement>["strokeWidth"];
  absoluteStrokeWidth?: boolean;
};
export type LucideIcon = React.ForwardRefExoticComponent<CanonicalIconProps>;

function createCanonicalIcon(
  icon: Icon,
  defaultWeight: IconWeight = "duotone",
): LucideIcon {
  const CanonicalIcon = icon;
  const ForwardedCanonicalIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
    ({ weight = defaultWeight, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props }, ref) => (
      <CanonicalIcon
        ref={ref}
        weight={weight}
        {...props}
        data-canonical-icon="true"
      />
    ),
  );
  ForwardedCanonicalIcon.displayName = "CanonicalIcon";
  return ForwardedCanonicalIcon;
}

export const Bold = createCanonicalIcon(Phosphor.TextB);
export const Image = createCanonicalIcon(Phosphor.Image);
export const Link = createCanonicalIcon(Phosphor.Link);
export const Map = createCanonicalIcon(Phosphor.MapPin);
export const Table = createCanonicalIcon(Phosphor.Table);

export const Activity = createCanonicalIcon(Phosphor.Pulse);
export const AlertCircle = createCanonicalIcon(Phosphor.WarningCircle);
export const AlertTriangle = createCanonicalIcon(Phosphor.Warning);
export const AlignCenter = createCanonicalIcon(Phosphor.TextAlignCenter);
export const AlignLeft = createCanonicalIcon(Phosphor.AlignLeft);
export const AlignRight = createCanonicalIcon(Phosphor.AlignRight);
export const ArrowDownLeft = createCanonicalIcon(Phosphor.ArrowDownLeft);
export const ArrowDownRight = createCanonicalIcon(Phosphor.ArrowDownRight);
export const ArrowLeft = createCanonicalIcon(Phosphor.ArrowLeft, "regular");
export const ArrowLeftRight = createCanonicalIcon(Phosphor.ArrowsLeftRight, "regular");
export const ArrowRight = createCanonicalIcon(Phosphor.ArrowRight, "regular");
export const ArrowRightLeft = createCanonicalIcon(Phosphor.ArrowsLeftRight, "regular");
export const ArrowUpDown = createCanonicalIcon(Phosphor.ArrowsDownUp, "regular");
export const ArrowUpRight = createCanonicalIcon(Phosphor.ArrowUpRight, "regular");
export const AudioLines = createCanonicalIcon(Phosphor.Waveform);
export const BadgeCheck = createCanonicalIcon(Phosphor.SealCheck);
export const Ban = createCanonicalIcon(Phosphor.Prohibit);
export const Banknote = createCanonicalIcon(Phosphor.Money);
export const BarChart3 = createCanonicalIcon(Phosphor.ChartBar);
export const Bell = createCanonicalIcon(Phosphor.Bell);
export const BookOpen = createCanonicalIcon(Phosphor.BookOpen);
export const BookOpenText = createCanonicalIcon(Phosphor.BookOpenText);
export const BookUser = createCanonicalIcon(Phosphor.AddressBook);
export const Bot = createCanonicalIcon(Phosphor.Robot);
export const Brain = createCanonicalIcon(Phosphor.Brain);
export const Briefcase = createCanonicalIcon(Phosphor.Briefcase);
export const BriefcaseBusiness = createCanonicalIcon(Phosphor.Briefcase);
export const Building2 = createCanonicalIcon(Phosphor.Buildings);
export const Cable = createCanonicalIcon(Phosphor.CableCar);
export const Calculator = createCanonicalIcon(Phosphor.Calculator);
export const Calendar = createCanonicalIcon(Phosphor.Calendar);
export const CalendarClock = createCanonicalIcon(Phosphor.CalendarDots);
export const CalendarDays = createCanonicalIcon(Phosphor.Calendar);
export const CalendarPlus = createCanonicalIcon(Phosphor.CalendarPlus);
export const ChartColumnIncreasing = createCanonicalIcon(Phosphor.ChartLineUp);
export const ChartNoAxesCombined = createCanonicalIcon(Phosphor.ChartLine);
export const Check = createCanonicalIcon(Phosphor.Check);
export const CheckCircle = createCanonicalIcon(Phosphor.CheckCircle);
export const CheckCircle2 = createCanonicalIcon(Phosphor.CheckCircle);
export const ChevronDown = createCanonicalIcon(Phosphor.CaretDown, "regular");
export const ChevronLeft = createCanonicalIcon(Phosphor.CaretLeft, "regular");
export const ChevronRight = createCanonicalIcon(Phosphor.CaretRight, "regular");
export const ChevronsUpDown = createCanonicalIcon(Phosphor.CaretUpDown, "regular");
export const ChevronUp = createCanonicalIcon(Phosphor.CaretUp, "regular");
export const CircleAlert = createCanonicalIcon(Phosphor.WarningCircle);
export const CircleAlertIcon = createCanonicalIcon(Phosphor.WarningCircle);
export const CircleCheck = createCanonicalIcon(Phosphor.CheckCircle);
export const CircleCheckIcon = createCanonicalIcon(Phosphor.CheckCircle);
export const CircleDashed = createCanonicalIcon(Phosphor.CircleDashed);
export const CircleIcon = createCanonicalIcon(Phosphor.Circle);
export const ClipboardCheck = createCanonicalIcon(Phosphor.Clipboard);
export const ClipboardCopy = createCanonicalIcon(Phosphor.Copy);
export const ClipboardList = createCanonicalIcon(Phosphor.ClipboardText);
export const Clock = createCanonicalIcon(Phosphor.Clock);
export const Clock3 = createCanonicalIcon(Phosphor.Clock);
export const Cloud = createCanonicalIcon(Phosphor.Cloud);
export const Code2 = createCanonicalIcon(Phosphor.Code);
export const Coffee = createCanonicalIcon(Phosphor.Coffee);
export const Coins = createCanonicalIcon(Phosphor.Coins);
export const Command = createCanonicalIcon(Phosphor.Command);
export const Compass = createCanonicalIcon(Phosphor.Compass);
export const ContactRound = createCanonicalIcon(Phosphor.AddressBook);
export const Copy = createCanonicalIcon(Phosphor.Copy);
export const Cpu = createCanonicalIcon(Phosphor.Cpu);
export const CreditCard = createCanonicalIcon(Phosphor.CreditCard);
export const Crosshair = createCanonicalIcon(Phosphor.Crosshair);
export const Crown = createCanonicalIcon(Phosphor.Crown);
export const Database = createCanonicalIcon(Phosphor.Database);
export const DollarSign = createCanonicalIcon(Phosphor.CurrencyDollar);
export const Download = createCanonicalIcon(Phosphor.Download);
export const ExternalLink = createCanonicalIcon(Phosphor.ArrowSquareOut);
export const Eye = createCanonicalIcon(Phosphor.Eye);
export const EyeOff = createCanonicalIcon(Phosphor.EyeSlash);
export const FileChartColumn = createCanonicalIcon(Phosphor.FileText);
export const FileCheck2 = createCanonicalIcon(Phosphor.FileText);
export const FilePenLine = createCanonicalIcon(Phosphor.NotePencil);
export const FileText = createCanonicalIcon(Phosphor.FileText);
export const FileUp = createCanonicalIcon(Phosphor.FileArrowUp);
export const Fingerprint = createCanonicalIcon(Phosphor.Fingerprint);
export const FolderLock = createCanonicalIcon(Phosphor.FolderSimpleLock);
export const FolderSearch = createCanonicalIcon(Phosphor.FolderSimple);
export const GitCompareArrows = createCanonicalIcon(Phosphor.GitBranch);
export const Globe = createCanonicalIcon(Phosphor.Globe);
export const GraduationCap = createCanonicalIcon(Phosphor.GraduationCap);
export const Grid2x2 = createCanonicalIcon(Phosphor.SquaresFour);
export const Hand = createCanonicalIcon(Phosphor.Hand);
export const Hash = createCanonicalIcon(Phosphor.Hash);
export const Heading2 = createCanonicalIcon(Phosphor.TextH);
export const Heart = createCanonicalIcon(Phosphor.Heart);
export const History = createCanonicalIcon(Phosphor.ClockCounterClockwise);
export const Home = createCanonicalIcon(Phosphor.House);
export const ImageIcon = createCanonicalIcon(Phosphor.Image);
export const Inbox = createCanonicalIcon(Phosphor.Tray);
export const Info = createCanonicalIcon(Phosphor.Info);
export const Italic = createCanonicalIcon(Phosphor.TextItalic);
export const Key = createCanonicalIcon(Phosphor.Key);
export const Keyboard = createCanonicalIcon(Phosphor.Keyboard);
export const KeyRound = createCanonicalIcon(Phosphor.Key);
export const Landmark = createCanonicalIcon(Phosphor.Bank);
export const Laptop = createCanonicalIcon(Phosphor.Laptop);
export const Layers = createCanonicalIcon(Phosphor.Stack);
export const Layers3 = createCanonicalIcon(Phosphor.Stack);
export const LayoutDashboard = createCanonicalIcon(Phosphor.SquaresFour);
export const LifeBuoy = createCanonicalIcon(Phosphor.Lifebuoy);
export const Lightbulb = createCanonicalIcon(Phosphor.Lightbulb);
export const LineChart = createCanonicalIcon(Phosphor.ChartLine);
export const Link2 = createCanonicalIcon(Phosphor.Link);
export const Linkedin = createCanonicalIcon(Phosphor.LinkedinLogo);
export const LinkIcon = createCanonicalIcon(Phosphor.Link);
export const List = createCanonicalIcon(Phosphor.List);
export const ListOrdered = createCanonicalIcon(Phosphor.ListNumbers);
// Keep shadcn's familiar circular loader silhouette while routing the legacy
// name through the canonical registry.
export const Loader2 = createCanonicalIcon(Phosphor.CircleNotch, "regular");
export const Loader2Icon = createCanonicalIcon(Phosphor.CircleNotch, "regular");
export const LocateFixed = createCanonicalIcon(Phosphor.Crosshair);
export const Lock = createCanonicalIcon(Phosphor.Lock);
export const LockKeyhole = createCanonicalIcon(Phosphor.LockKey);
export const LogIn = createCanonicalIcon(Phosphor.SignIn);
export const LogOut = createCanonicalIcon(Phosphor.SignOut);
export const Mail = createCanonicalIcon(Phosphor.EnvelopeSimple);
export const MailCheck = createCanonicalIcon(Phosphor.EnvelopeSimple);
export const MailPlus = createCanonicalIcon(Phosphor.EnvelopeSimple);
export const MapIcon = createCanonicalIcon(Phosphor.MapPin);
export const MapPin = createCanonicalIcon(Phosphor.MapPin);
export const MapPinCheck = createCanonicalIcon(Phosphor.MapPin);
export const MapPinned = createCanonicalIcon(Phosphor.MapPin);
export const MapPinOff = createCanonicalIcon(Phosphor.MapPin);
export const Maximize2 = createCanonicalIcon(Phosphor.ArrowsOut);
export const Minimize2 = createCanonicalIcon(Phosphor.ArrowsIn);
export const Medal = createCanonicalIcon(Phosphor.Medal);
export const Menu = createCanonicalIcon(Phosphor.List, "regular");
export const MenuSquare = createCanonicalIcon(Phosphor.List, "regular");
export const MessageCircle = createCanonicalIcon(Phosphor.ChatCircle);
export const MessageSquareText = createCanonicalIcon(Phosphor.ChatText);
export const Mic = createCanonicalIcon(Phosphor.Microphone);
export const MicOff = createCanonicalIcon(Phosphor.MicrophoneSlash);
export const Minus = createCanonicalIcon(Phosphor.Minus);
export const MoreHorizontal = createCanonicalIcon(Phosphor.DotsThree);
export const MoreVertical = createCanonicalIcon(Phosphor.DotsThreeVertical);
export const Navigation = createCanonicalIcon(Phosphor.NavigationArrow);
export const Newspaper = createCanonicalIcon(Phosphor.Newspaper);
export const PanelLeftIcon = createCanonicalIcon(Phosphor.SidebarSimple, "regular");
export const Pause = createCanonicalIcon(Phosphor.Pause);
export const Pencil = createCanonicalIcon(Phosphor.Pencil);
export const PencilLine = createCanonicalIcon(Phosphor.Pencil);
export const PenLine = createCanonicalIcon(Phosphor.Pencil);
export const Percent = createCanonicalIcon(Phosphor.Percent);
export const Phone = createCanonicalIcon(Phosphor.Phone);
export const PhoneCall = createCanonicalIcon(Phosphor.PhoneCall);
export const PieChart = createCanonicalIcon(Phosphor.ChartPie);
export const Play = createCanonicalIcon(Phosphor.Play);
export const PlugZap = createCanonicalIcon(Phosphor.Plug);
export const Plus = createCanonicalIcon(Phosphor.Plus, "regular");
export const Quote = createCanonicalIcon(Phosphor.Quotes);
export const Receipt = createCanonicalIcon(Phosphor.Receipt);
export const RefreshCcw = createCanonicalIcon(Phosphor.ArrowsCounterClockwise, "regular");
export const RefreshCw = createCanonicalIcon(Phosphor.ArrowsClockwise, "regular");
export const RotateCcw = createCanonicalIcon(Phosphor.ArrowCounterClockwise, "regular");
export const Route = createCanonicalIcon(Phosphor.GitBranch);
export const Rows3 = createCanonicalIcon(Phosphor.Rows);
export const Save = createCanonicalIcon(Phosphor.FloppyDisk);
export const Scale = createCanonicalIcon(Phosphor.Scales);
export const ScanSearch = createCanonicalIcon(Phosphor.MagnifyingGlass);
export const ScrollText = createCanonicalIcon(Phosphor.Scroll);
export const Search = createCanonicalIcon(Phosphor.MagnifyingGlass, "regular");
export const SearchCheck = createCanonicalIcon(Phosphor.MagnifyingGlass, "regular");
export const SearchX = createCanonicalIcon(Phosphor.MagnifyingGlass, "regular");
export const Send = createCanonicalIcon(Phosphor.PaperPlaneRight);
export const SendHorizontal = createCanonicalIcon(Phosphor.PaperPlaneRight);
export const Settings = createCanonicalIcon(Phosphor.GearSix);
export const Settings2 = createCanonicalIcon(Phosphor.Sliders);
export const Share2 = createCanonicalIcon(Phosphor.ShareNetwork);
export const Shield = createCanonicalIcon(Phosphor.Shield);
export const ShieldAlert = createCanonicalIcon(Phosphor.ShieldWarning);
export const ShieldCheck = createCanonicalIcon(Phosphor.ShieldCheck);
export const ShieldOff = createCanonicalIcon(Phosphor.ShieldSlash);
export const ShoppingBag = createCanonicalIcon(Phosphor.ShoppingBag);
export const Siren = createCanonicalIcon(Phosphor.Siren);
export const SlidersHorizontal = createCanonicalIcon(Phosphor.SlidersHorizontal);
export const Smartphone = createCanonicalIcon(Phosphor.DeviceMobile);
export const Sparkles = createCanonicalIcon(Phosphor.Sparkle);
export const Star = createCanonicalIcon(Phosphor.Star);
export const Store = createCanonicalIcon(Phosphor.Storefront);
export const Target = createCanonicalIcon(Phosphor.Target);
export const Timer = createCanonicalIcon(Phosphor.Timer);
export const ThumbsDown = createCanonicalIcon(Phosphor.ThumbsDown);
export const ThumbsUp = createCanonicalIcon(Phosphor.ThumbsUp);
export const Trash2 = createCanonicalIcon(Phosphor.Trash);
export const TrendingDown = createCanonicalIcon(Phosphor.TrendDown);
export const TrendingUp = createCanonicalIcon(Phosphor.TrendUp);
export const TrendingUpDown = createCanonicalIcon(Phosphor.TrendUp);
export const TriangleAlert = createCanonicalIcon(Phosphor.Warning);
export const TriangleAlertIcon = createCanonicalIcon(Phosphor.Warning);
export const Trophy = createCanonicalIcon(Phosphor.Trophy);
export const Underline = createCanonicalIcon(Phosphor.TextUnderline);
export const Undo2 = createCanonicalIcon(Phosphor.ArrowUUpLeft);
export const Unplug = createCanonicalIcon(Phosphor.Plugs);
export const Upload = createCanonicalIcon(Phosphor.Upload);
export const User = createCanonicalIcon(Phosphor.User);
export const UserPlus = createCanonicalIcon(Phosphor.UserPlus);
export const UserRound = createCanonicalIcon(Phosphor.UserCircle);
export const UserRoundCheck = createCanonicalIcon(Phosphor.UserCircleCheck);
export const UserRoundPlus = createCanonicalIcon(Phosphor.UserCirclePlus);
export const Users = createCanonicalIcon(Phosphor.Users);
export const UsersRound = createCanonicalIcon(Phosphor.UsersThree);
export const Volume2 = createCanonicalIcon(Phosphor.SpeakerHigh);
export const Wallet = createCanonicalIcon(Phosphor.Wallet);
export const WalletCards = createCanonicalIcon(Phosphor.Wallet);
export const Wifi = createCanonicalIcon(Phosphor.WifiHigh);
export const WifiOff = createCanonicalIcon(Phosphor.WifiSlash);
export const Workflow = createCanonicalIcon(Phosphor.FlowArrow);
export const X = createCanonicalIcon(Phosphor.X, "regular");
export const XCircle = createCanonicalIcon(Phosphor.XCircle);
export const Zap = createCanonicalIcon(Phosphor.Lightning);
