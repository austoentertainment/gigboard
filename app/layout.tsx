import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bodyFont = localFont({
  src: "./fonts/PlusJakartaSans-Variable.ttf",
  variable: "--font-body",
  display: "swap",
});

const headingFont = localFont({
  src: "./fonts/PPEditorialNew-Regular.ttf",
  variable: "--font-heading",
  weight: "400",
  style: "normal",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Austo Gig Board",
  description: "Lead pipeline and DJ date-check board for Austo Entertainment",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${bodyFont.variable} ${headingFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
