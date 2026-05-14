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
    <html lang="en" className="dark">
      <body
        className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable} font-sans`}
      >
        <TenantProvider>{children}</TenantProvider>
      </body>
    </html>
  );
}
