"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DraftControls({ storyId, csrfToken, status }: { storyId: string; csrfToken: string; status: string }) {
  const [message, setMessage] = useState<string>(),
    router = useRouter();
  async function changePublication(action: "publish" | "unpublish") {
    const response = await fetch(`/api/stories/${storyId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
      body: JSON.stringify({ action }),
    });
    const body = (await response.json()) as { data?: { story: { publicSlug?: string } }; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? "Wanderpage could not change publication status.");
    setMessage(action === "publish" ? "Published. You can still revoke it from this private page." : "Public access revoked.");
    router.refresh();
  }

  async function remove() {
    const response = await fetch(`/api/stories/${storyId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
    });
    if (!response.ok) return setMessage("Wanderpage could not delete this story. Try again.");
    router.push("/");
  }

  if (status === "deleting" || status === "deleted") return <p className="product-kicker">This story is being deleted.</p>;
  return (
    <section style={{ padding: "1.5rem 6vw" }}>
      <p className="product-kicker">Owner controls — only this browser session can use them</p>
      {status === "draft" && (
        <button className="product-cta" type="button" onClick={() => void changePublication("publish")}>
          Publish this story <span>→</span>
        </button>
      )}
      {status === "published" && (
        <>
          <button className="product-cta" type="button" onClick={() => void changePublication("unpublish")}>
            Revoke public access
          </button>
          <p>
            Revocation is immediate at Wanderpage. A previously loaded image can remain in a browser or edge cache for its bounded cache
            lifetime.
          </p>
        </>
      )}
      <button type="button" onClick={() => void remove()}>
        Delete this story and its media
      </button>
      {status !== "draft" && status !== "published" && <p>Draft status: {status}. Processing updates appear on this page.</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
