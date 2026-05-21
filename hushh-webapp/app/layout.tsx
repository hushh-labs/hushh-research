import { NetworkStatusBanner } from "@/components/system/network-status-banner";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { RootLayoutClient } from "./layout-client";
import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
} from "@/lib/observability/env";

// Configure web typography frameworks with structural configuration blocks
const geistSans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-app-body",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-app-mono",
});

const headingSans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-app-heading",
});

const gtmContainerId = resolveGtmContainerId();
const analyticsMeasurementId = resolveAnalyticsMeasurementId();

export const metadata: Metadata = {
  title: {
    default: "One: Your Personal Agent",
    template: "%s | One Personal Agent"
  },
  description: "Personal AI agents with consent at the core. Your data, your control.",
  keywords: ["AI agents", "personal AI", "One", "consent-first", "privacy", "hushh"],
  authors: [{ name: "Hushh Labs", url: "https://hushh.ai" }],
  applicationName: "One Agent Workspace",
  icons: {
    icon: [
      { url: "/quiet-emoji-icon.svg", type: "image/svg+xml" },
      { url: "/quiet-emoji-icon.png", type: "image/png", sizes: "512x512" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    shortcut: "/quiet-emoji-icon.svg",
    apple: "/quiet-emoji-icon.png",
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "One: Your Personal Agent",
    description: "Personal AI agents with consent at the core. Your data, your control.",
    type: "website",
    siteName: "One Platform",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "One: Your Personal Agent",
    description: "Personal AI agents with consent at the core.",
    creator: "@hushh_labs"
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
    }
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1c1e" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html 
      lang="en" 
      suppressHydrationWarning 
      className={`h-full antialiased scroll-smooth selection:bg-hushh-blue-500/30`}
    >
      <head>
        {/* Establish vital domain connection warming hints to optimize network latency */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://www.googletagmanager.com" crossOrigin="anonymous" />
        
        <style>{`
          html.dark body,
          html.dark .morphy-app-bg {
            background-color: rgb(28 28 30) !important;
            background-image: none !important;
          }
          /* Screen reader utility styling block for skip link context layout */
          .skip-to-content:not(:focus) {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
          }
        `}</style>

        {/* Google Analytics Integration Strategy Layout */}
        {analyticsMeasurementId ? (
          <>
            <Script
              id="ga-base"
              strategy="afterInteractive"
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer = window.dataLayer || []; window.gtag = window.gtag || function(){window.dataLayer.push(arguments);}; window.gtag('js', new Date()); window.gtag('config', '${analyticsMeasurementId}', { send_page_view: false, anonymize_ip: true });`,
              }}
            />
            <Script
              id="ga-loader"
              strategy="afterInteractive"
              src={`https://www.googletagmanager.com/gtag/js?id=${analyticsMeasurementId}`}
              onError={(e) => {
                console.warn("Telemetry Pipeline Blocked: Client side telemetry package initialization bypassed.", e);
              }}
            />
          </>
        ) : null}

        {/* Google Tag Manager Strategy Layout */}
        {gtmContainerId ? (
          <Script
            id="gtm-base"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':Date.now(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode&&f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmContainerId}');`,
            }}
            onError={(e) => {
              console.warn("Core Pipeline Warning: Tag Manager asset execution bypassed.", e);
            }}
          />
        ) : null}
      </head>

      <body className="h-full font-sans bg-background text-foreground transition-colors duration-150">
        {/* Core Keyboard Navigation Access Assist Layer */}
        <a 
          href="#main-application-content" 
          className="skip-to-content fixed top-4 left-4 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md shadow text-sm font-medium focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
        >
          Skip to main content
        </a>

        {/* Global Structural Client State Provider Wrapper */}
        <RootLayoutClient
          fontClasses={`${geistSans.variable} ${geistMono.variable} ${headingSans.variable}`}
        >
          {/* Diagnostic Network State Tracker Notification Layer */}
          <NetworkStatusBanner />
          
          {/* Structured Main Content Landmark Layout */}
          <div id="main-application-content" className="min-h-full flex flex-col" role="presentation">
            {children}
          </div>
        </RootLayoutClient>
      </body>
    </html>
  );
}