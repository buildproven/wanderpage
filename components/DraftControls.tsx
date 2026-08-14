"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DraftControls({ storyId, csrfToken, status }: { storyId: string; csrfToken: string; status: string }) {
  const [message, setMessage] = useState<string>(),
    router = useRouter();
  async function publish() {
    const response = await fetch(`/api/stories/${storyId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
      body: JSON.stringify({ action: "publish" }),
    });
    const body = (await response.json()) as { data?: { story: { publicSlug?: string } }; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? "Wanderpage could not publish this story.");
    router.push(`/s/${body.data.story.publicSlug}`);
  }
  if (status !== "draft")
    return <p className="product-kicker">Draft status: {status}. This page will update after processing completes.</p>;
  return (
    <section style={{ padding: "1.5rem 6vw" }}>
      <p className="product-kicker">Private draft — only you can see this page</p>
      <button className="product-cta" type="button" onClick={() => void publish()}>
        Publish this story <span>→</span>
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
