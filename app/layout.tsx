import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A Line Along the Pacific — Wanderpage",
  description: "A quiet passage down the Oregon Coast, told in photographs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
