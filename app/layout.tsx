import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wanderpage — Your trip, edited into a story",
  description: "Turn a folder of vacation photos into a cinematic travel story—kept local until you choose to share it.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
