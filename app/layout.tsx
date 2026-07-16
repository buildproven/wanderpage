import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wanderpage — Your trip, edited into a story",
  description: "Turn a folder of vacation photos into a cinematic, private, shareable travel story.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
