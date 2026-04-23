import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { RootLayoutClient } from "./layout-client";
import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
} from "@/lib/observability/env";

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
  title: "Kai: Your Personal Agent",
  description:
    "Personal AI agents with consent at the core. Your data, your control.",
  keywords: ["AI agents", "personal AI", "Kai", "consent-first", "privacy"],
  authors: [{ name: "Hussh Labs" }],
  openGraph: {
    title: "Kai: Your Personal Agent",
    description: "Personal AI agents with consent at the core.",
    type: "website",
  },
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
    <html lang="en" suppressHydrationWarning className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <style>{`
          html.dark body,
          html.dark .morphy-app-bg {
            background-color: rgb(28 28 30) !important;
            background-image: none !important;
          }
        `}</style>
        {analyticsMeasurementId ? (
          <>
            <Script
              id="ga-base"
              strategy="afterInteractive"
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer = window.dataLayer || []; window.gtag = window.gtag || function(){window.dataLayer.push(arguments);}; window.gtag('js', new Date()); window.gtag('config', '${analyticsMeasurementId}', { send_page_view: false });`,
              }}
            />
            <Script
              id="ga-loader"
              strategy="afterInteractive"
              src={`https://www.googletagmanager.com/gtag/js?id=${analyticsMeasurementId}`}
            />
          </>
        ) : null}
        {gtmContainerId ? (
          <Script
            id="gtm-base"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':Date.now(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode&&f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmContainerId}');`,
            }}
          />
        ) : null}
      </head>
      <RootLayoutClient
        fontClasses={`${geistSans.variable} ${geistMono.variable} ${headingSans.variable}`}
      >
        {children}
      </RootLayoutClient>
    </html>
  );
}
