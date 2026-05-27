import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { TenantProvider } from "@/context/tenant-context";
import "./globals.css";

const fontSans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const fontDisplay = Inter({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
});

const fontMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Merchant Hub — Order Automation",
  description: "Manage Messenger orders, catalog, and integrations for your business.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` on <html> + <body> silences the noisy
    // hydration warning that fires when a browser extension (Grammarly,
    // LanguageTool, Compose AI, Honey, etc.) injects attributes like
    // `data-new-gr-c-s-check-loaded`, `data-gr-ext-installed`, or
    // `cz-shortcut-listen` onto these elements BEFORE React hydrates.
    // The warning is otherwise misleading — it points at the first
    // sibling diff (in our case the footer's <li>) rather than the
    // real root cause. The flag only suppresses the diff at this exact
    // element; React still validates and warns on every other node.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable} font-sans`}
        suppressHydrationWarning
      >
        <TenantProvider>{children}</TenantProvider>
      </body>
    </html>
  );
}
