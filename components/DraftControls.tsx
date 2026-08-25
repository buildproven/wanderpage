"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { TripManifest } from "@/lib/schemas/trip";
import styles from "./HostedDraftDesk.module.css";

type DraftStory = {
  id: string;
  title: string;
  status: string;
  publicSlug?: string;
  version: number;
  peopleMode: "include" | "exclude";
  locationPrivacy: "broad" | "approximate" | "hidden";
  manifest?: TripManifest;
};

export default function DraftControls({ story: initialStory, csrfToken }: { story: DraftStory; csrfToken: string }) {
  const [story, setStory] = useState(initialStory),
    [title, setTitle] = useState(initialStory.title),
    [peopleMode, setPeopleMode] = useState(initialStory.peopleMode),
    [locationPrivacy, setLocationPrivacy] = useState(initialStory.locationPrivacy),
    [message, setMessage] = useState<string>(),
    [busy, setBusy] = useState(false),
    router = useRouter();
  const active = story.status === "queued" || story.status === "processing",
    editable = story.status === "uploading" || story.status === "draft",
    privacyLocked = story.status === "draft",
    dirty = title !== story.title || peopleMode !== story.peopleMode || locationPrivacy !== story.locationPrivacy,
    statusCopy = useMemo(() => statusDescription(story.status), [story.status]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/stories/${initialStory.id}`, { cache: "no-store" }),
          body = (await response.json()) as { data?: { story: DraftStory }; error?: { message?: string } };
        if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not refresh this draft.");
        if (disposed) return;
        setStory(body.data.story);
        if (body.data.story.status !== "queued" && body.data.story.status !== "processing") router.refresh();
      } catch (error) {
        if (!disposed) setMessage(messageFor(error));
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, initialStory.id, router]);

  async function saveDraft() {
    if (!editable || !dirty) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/stories/${story.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
          body: JSON.stringify({ version: story.version, title, peopleMode, locationPrivacy }),
        }),
        body = (await response.json()) as { data?: { story: DraftStory }; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not save this draft.");
      setStory(body.data.story);
      setMessage("Private draft saved.");
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (story.status !== "failed") return;
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/stories/${story.id}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
        }),
        body = (await response.json()) as { data?: { story: DraftStory }; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not retry this draft.");
      setStory(body.data.story);
      setMessage("Retry accepted. Wanderpage is curating the private draft again.");
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function changePublication(action: "publish" | "unpublish") {
    setBusy(true);
    try {
      const response = await fetch(`/api/stories/${story.id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
          body: JSON.stringify({ action }),
        }),
        body = (await response.json()) as { data?: { story: { publicSlug?: string } }; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Wanderpage could not change publication status.");
      setMessage(action === "publish" ? "Published. You can still revoke it from this private page." : "Public access revoked.");
      router.refresh();
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Permanently delete this story and all of its media? This cannot be undone.")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/stories/${story.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-wanderpage-csrf": csrfToken },
      });
      if (!response.ok) throw new Error("Wanderpage could not delete this story. Try again.");
      router.push("/");
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles["hosted-draft-desk"]} aria-label="Private story controls">
      <div className={styles["hosted-draft-heading"]}>
        <div>
          <p className="product-kicker">Private draft desk</p>
          <h1>{story.title}</h1>
        </div>
        <span
          className={`${styles["hosted-status"]} ${styles[`hosted-status-${story.status}`] ?? ""}`}
          aria-label={`Draft status: ${story.status}`}
        >
          {story.status}
        </span>
      </div>

      <div className={styles["hosted-draft-status"]} aria-live="polite">
        <div>
          <strong>{statusCopy.title}</strong>
          <p>{statusCopy.detail}</p>
        </div>
        {active && (
          <div className={styles["hosted-progress"]} aria-label="Private draft processing">
            <i />
          </div>
        )}
        {story.status === "failed" && (
          <button
            className={`${styles["hosted-text-action"]} ${styles["hosted-text-action-accent"]}`}
            type="button"
            disabled={busy}
            onClick={() => void retry()}
          >
            Retry curation →
          </button>
        )}
      </div>

      {story.manifest && (
        <div className={styles["hosted-draft-evidence"]} aria-label="Private draft summary">
          <div>
            <strong>{story.manifest.photos.filter(photo => photo.source === "user").length}</strong>
            <span>selected frames</span>
          </div>
          <div>
            <strong>{story.manifest.chapters.length}</strong>
            <span>story chapters</span>
          </div>
          <div>
            <strong>{story.manifest.destinations.length}</strong>
            <span>destination notes</span>
          </div>
          <div>
            <strong>{locationLabel(story.locationPrivacy)}</strong>
            <span>location boundary</span>
          </div>
        </div>
      )}

      {editable && (
        <form
          className={styles["hosted-draft-editor"]}
          onSubmit={event => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <div>
            <p className="product-kicker">Shape the draft</p>
            <h2>Keep the edit yours.</h2>
            <p>
              Change the title while the story is private. Privacy choices are available before processing and lock after the draft is made.
            </p>
          </div>
          <label>
            Story title
            <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} disabled={busy} />
          </label>
          <fieldset disabled={busy || privacyLocked}>
            <legend>People boundary</legend>
            <label>
              <input type="radio" name="people-mode" checked={peopleMode === "exclude"} onChange={() => setPeopleMode("exclude")} />
              Exclude photos that contain people
            </label>
            <label>
              <input type="radio" name="people-mode" checked={peopleMode === "include"} onChange={() => setPeopleMode("include")} />
              Allow photos containing people
            </label>
          </fieldset>
          <fieldset disabled={busy || privacyLocked}>
            <legend>Location privacy</legend>
            <label>
              <input
                type="radio"
                name="location-privacy"
                checked={locationPrivacy === "broad"}
                onChange={() => setLocationPrivacy("broad")}
              />
              Broad region only
            </label>
            <label>
              <input
                type="radio"
                name="location-privacy"
                checked={locationPrivacy === "approximate"}
                onChange={() => setLocationPrivacy("approximate")}
              />
              Approximate locations
            </label>
            <label>
              <input
                type="radio"
                name="location-privacy"
                checked={locationPrivacy === "hidden"}
                onChange={() => setLocationPrivacy("hidden")}
              />
              Do not show locations
            </label>
          </fieldset>
          <div className={styles["hosted-editor-actions"]}>
            {privacyLocked && <span>Privacy choices are fixed for this completed draft.</span>}
            <button
              className={`${styles["hosted-text-action"]} ${styles["hosted-text-action-accent"]}`}
              type="submit"
              disabled={busy || !dirty}
            >
              {busy ? "Saving…" : "Save private draft"}
            </button>
          </div>
        </form>
      )}

      <div className={styles["hosted-draft-actions"]}>
        {story.status === "draft" && (
          <button className="product-cta" type="button" disabled={busy} onClick={() => void changePublication("publish")}>
            Publish this story <span>→</span>
          </button>
        )}
        {story.status === "published" && (
          <>
            <button className="product-cta" type="button" disabled={busy} onClick={() => void changePublication("unpublish")}>
              Revoke public access
            </button>
            <p>
              Revocation is immediate at Wanderpage. A previously loaded image can remain in a browser or edge cache for its bounded cache
              lifetime.
            </p>
          </>
        )}
        {(story.status === "draft" || story.status === "published") && story.publicSlug && (
          <a className={styles["hosted-text-action"]} href={`/s/${story.publicSlug}`}>
            Open public story →
          </a>
        )}
        <button
          className={`${styles["hosted-text-action"]} ${styles["hosted-text-action-muted"]}`}
          type="button"
          disabled={busy}
          onClick={() => void remove()}
        >
          Delete this story and its media
        </button>
      </div>
      {message && (
        <p className={styles["hosted-draft-message"]} role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function statusDescription(status: string) {
  switch (status) {
    case "uploading":
      return {
        title: "Private source set is ready for your next step.",
        detail: "Confirm the settings below, then start curation when every photo has uploaded.",
      };
    case "queued":
      return {
        title: "Your private edit is queued.",
        detail: "The source photos are locked to this run. You can leave this page and return to it.",
      };
    case "processing":
      return {
        title: "Wanderpage is curating the sequence.",
        detail: "We are selecting frames, shaping the narrative, and preparing private web images.",
      };
    case "draft":
      return { title: "Your private draft is ready.", detail: "Review the finished story below. Nothing is public until you publish it." };
    case "published":
      return {
        title: "This story is public by your choice.",
        detail: "You can revoke public access or delete the story and its media from here.",
      };
    case "failed":
      return {
        title: "Curation stopped before publication.",
        detail: "Your original photos remain private. Retry while the source retention window is open.",
      };
    case "deleting":
    case "deleted":
      return { title: "This story is being deleted.", detail: "Private media access is already closed." };
    default:
      return { title: "Private draft", detail: "Wanderpage is checking the current story state." };
  }
}

function locationLabel(value: DraftStory["locationPrivacy"]) {
  return value === "approximate" ? "Approx." : value === "broad" ? "Broad" : "Hidden";
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Wanderpage could not complete that request.";
}
