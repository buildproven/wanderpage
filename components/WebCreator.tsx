"use client";

import { upload } from "@vercel/blob/client";
import { useEffect, useState } from "react";
import { currentDisclosureVersion } from "@/lib/consent";
import styles from "./HostedDraftDesk.module.css";

const termsVersion = currentDisclosureVersion;
type Story = { id: string; title: string; status: string; publicSlug?: string };

export default function WebCreator() {
  const [title, setTitle] = useState(""),
    [peopleMode, setPeopleMode] = useState<"include" | "exclude">("exclude"),
    [locationPrivacy, setLocationPrivacy] = useState<"broad" | "approximate" | "hidden">("broad"),
    [files, setFiles] = useState<File[]>([]),
    [accepted, setAccepted] = useState(false),
    [csrfToken, setCsrfToken] = useState<string>(),
    [story, setStory] = useState<Story>(),
    [existingStories, setExistingStories] = useState<Story[]>([]),
    [uploadIndex, setUploadIndex] = useState(0),
    [message, setMessage] = useState<string>(),
    [busy, setBusy] = useState(false);

  useEffect(() => {
    void request<{ csrfToken: string; stories: Story[] }>("/api/stories", { method: "GET" })
      .then(result => {
        setCsrfToken(result.csrfToken);
        setExistingStories(result.stories);
      })
      .catch(() => undefined);
  }, []);

  async function createAndUpload() {
    if (!accepted || files.length < 6 || files.length > 60 || !title.trim()) return;
    setBusy(true);
    setMessage(undefined);
    setUploadIndex(0);
    try {
      const created = await request<{ story: Story; csrfToken: string }>("/api/stories", {
        method: "POST",
        headers: csrfToken ? { "x-wanderpage-csrf": csrfToken } : undefined,
        body: JSON.stringify({ title, peopleMode, locationPrivacy, termsVersion, uploadConsentVersion: termsVersion }),
      });
      setStory(created.story);
      setCsrfToken(created.csrfToken);
      for (const [index, file] of files.entries()) {
        setUploadIndex(index + 1);
        const reservation = await request<{ upload: { blobPath: string }; uploadPayload: string }>("/api/upload-reservations", {
          method: "POST",
          headers: { "x-wanderpage-csrf": created.csrfToken },
          body: JSON.stringify({ storyId: created.story.id, originalName: file.name, contentType: file.type, byteSize: file.size }),
        });
        await upload(reservation.upload.blobPath, file, {
          access: "private",
          handleUploadUrl: "/api/uploads",
          clientPayload: reservation.uploadPayload,
          headers: { "x-wanderpage-csrf": created.csrfToken },
          contentType: file.type,
        });
      }
      setExistingStories(current => [created.story, ...current.filter(value => value.id !== created.story.id)]);
      setMessage("Photos uploaded privately. Generate the draft when you are ready.");
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
      setUploadIndex(0);
    }
  }

  async function generate() {
    if (!story || !csrfToken) return;
    setBusy(true);
    try {
      const result = await request<{ story: Story }>(`/api/stories/${story.id}/generate`, {
        method: "POST",
        headers: { "x-wanderpage-csrf": csrfToken },
      });
      setStory(result.story);
      setMessage("Your private draft is being curated. Open its private review page in a few minutes to publish when it is ready.");
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-page" style={{ padding: "3rem 6vw", minHeight: "100vh" }}>
      <p className="product-kicker">Private browser creation</p>
      <h1 style={{ maxWidth: 760 }}>Turn a photo folder into a story.</h1>
      <p style={{ maxWidth: 680 }}>
        Your photos upload privately for curation. Wanderpage never identifies people, and you choose whether places are broad, approximate,
        or hidden. Nothing is public until you explicitly publish a finished draft.
      </p>
      <form
        onSubmit={event => {
          event.preventDefault();
          void createAndUpload();
        }}
        style={{ display: "grid", gap: "1rem", maxWidth: 680, marginTop: "2rem" }}
      >
        <label>
          Story title
          <input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required />
        </label>
        <label>
          Photos (JPEG, PNG, or WebP; 6–60 total)
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            required
            onChange={event => setFiles(Array.from(event.target.files ?? []))}
          />
        </label>
        <label>
          People boundary
          <select value={peopleMode} onChange={event => setPeopleMode(event.target.value as "include" | "exclude")}>
            <option value="exclude">Exclude photos that contain people</option>
            <option value="include">Allow photos containing people</option>
          </select>
        </label>
        <label>
          Location privacy
          <select value={locationPrivacy} onChange={event => setLocationPrivacy(event.target.value as "broad" | "approximate" | "hidden")}>
            <option value="broad">Broad region only</option>
            <option value="approximate">Approximate locations</option>
            <option value="hidden">Do not show locations</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required /> I have the right to
          upload these photos. I consent to source uploads expiring after 24 hours and being automatically deleted within 48 hours, derived
          contact-sheet processing by OpenAI, and automatic deletion of an unpublished draft after 30 days of inactivity. I understand that
          losing this anonymous browser session means losing access.
        </label>
        <button className="product-cta" type="submit" disabled={busy || !accepted || files.length < 6 || files.length > 60}>
          {busy ? (uploadIndex ? `Uploading ${uploadIndex} of ${files.length}…` : "Starting private draft…") : "Upload privately"}
        </button>
      </form>
      {story && (
        <section style={{ marginTop: "2rem", maxWidth: 680 }}>
          <p>
            Draft status: <strong>{story.status}</strong>
          </p>
          <button className="product-cta" type="button" disabled={busy || story.status !== "uploading"} onClick={() => void generate()}>
            Generate private draft <span>→</span>
          </button>
          <p>
            <a href={`/stories/${story.id}`}>Open private review →</a>
          </p>
        </section>
      )}
      {message && (
        <p role="status" style={{ marginTop: "1.5rem", maxWidth: 680 }}>
          {message}
        </p>
      )}
      {existingStories.length > 0 && (
        <section className={styles["hosted-story-list"]} aria-labelledby="existing-drafts-title">
          <p className="product-kicker">Your private shelf</p>
          <h2 id="existing-drafts-title">Return to a draft.</h2>
          <p>These stories belong to this anonymous browser session. Keep the session cookie to keep access.</p>
          <div>
            {existingStories.map(value => (
              <a href={`/stories/${value.id}`} key={value.id}>
                <span>{value.status}</span>
                <strong>{value.title}</strong>
                <span>Open →</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } }),
    body = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not complete that request.");
  return body.data;
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Wanderpage could not complete that request.";
}
