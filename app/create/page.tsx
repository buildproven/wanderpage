import type { Metadata } from "next";
import Link from "next/link";
import WebCreator from "@/components/WebCreator";

const hostedCreatorEnabled = process.env.WANDERPAGE_GENERATION_ENABLED === "true";

export const metadata: Metadata = {
  title: hostedCreatorEnabled ? "Create a story — Wanderpage" : "Create a story — coming soon — Wanderpage",
  description: hostedCreatorEnabled
    ? "Privately upload travel photos and create a Wanderpage draft in your browser."
    : "Hosted browser creation is coming soon to Wanderpage.",
};

export default function CreatePage() {
  if (hostedCreatorEnabled) return <WebCreator />;

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
