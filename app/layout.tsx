import type { Metadata } from "next";
import "./globals.css";

// Hosted pages must render per request so Next can apply the proxy-generated
// CSP nonce to its scripts. The rollback exporter removes this declaration in
// its isolated copy because that artifact has no server or authenticated data.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Wanderpage — Your trip, edited into a story",
  description: "Turn a folder of vacation photos into a cinematic travel story—kept local until you choose to share it.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const fonts = {
    "--font-editorial": "Georgia, 'Times New Roman', serif",
    "--font-sans": "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "--font-mono": "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  } as React.CSSProperties;
  return (
    <html lang="en">
      <body style={fonts}>{children}</body>
    </html>
  );
}
