import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Create a story — coming soon — Wanderpage",
  description: "Hosted browser creation is coming soon to Wanderpage.",
};

export default function CreatePage() {
  return (
    <main className="product-page" style={{ padding: "3rem 6vw", minHeight: "100vh" }}>
      <p className="product-kicker">Hosted browser creation · Coming soon</p>
      <h1 style={{ maxWidth: 760 }}>Turn a photo folder into a finished story.</h1>
      <p style={{ maxWidth: 680 }}>
        Uploading photos and generating a Wanderpage directly in the browser is coming soon. Until then, explore the finished demo or use
        the private local launcher with your own OpenAI key.
      </p>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "2rem" }}>
        <Link href="/demo" className="product-cta">
          Explore the demo <span>→</span>
        </Link>
      </div>
    </main>
  );
}
