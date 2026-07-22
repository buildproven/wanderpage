"use client";

import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { TripManifest } from "@/lib/schemas/trip";
import type { StudioJob, StudioStatus } from "@/lib/studio/types";

type Connection = "checking" | "ready" | "offline";
type ManagedTrip = { slug: string; manifest: TripManifest };

export default function Studio() {
  const [connection, setConnection] = useState<Connection>("checking"),
    [status, setStatus] = useState<StudioStatus>();
  const [folder, setFolder] = useState(""),
    [title, setTitle] = useState(""),
    [people, setPeople] = useState<"include" | "exclude">("include"),
    [privacy, setPrivacy] = useState<"approximate" | "exact">("approximate"),
    [maxPhotos, setMaxPhotos] = useState(36);
  const [job, setJob] = useState<StudioJob>(),
    [error, setError] = useState(""),
    [picking, setPicking] = useState(false),
    [trips, setTrips] = useState<ManagedTrip[]>([]),
    [reviewTrip, setReviewTrip] = useState<ManagedTrip>(),
    [draft, setDraft] = useState<TripManifest>(),
    [removedPhotos, setRemovedPhotos] = useState<TripManifest["photos"]>([]),
    [saving, setSaving] = useState(false);

  useEffect(() => {
    void api<StudioStatus>("/api/status")
      .then(value => {
        setStatus(value);
        setPeople(value.openaiConfigured ? "exclude" : "include");
        setConnection("ready");
        void loadTrips().catch(reason => setError(reason instanceof Error ? reason.message : "Unable to load your local trip library."));
      })
      .catch(() => setConnection("offline"));
  }, []);
  useEffect(() => {
    if (!job || ["complete", "failed"].includes(job.status)) return;
    const timer = window.setInterval(
      () =>
        void api<StudioJob>(`/api/jobs/${job.id}`)
          .then(value => {
            setJob(value);
            setError("");
            if (value.status === "complete")
              void loadTrips().catch(reason =>
                setError(reason instanceof Error ? reason.message : "Unable to refresh your local trip library.")
              );
          })
          .catch(reason => setError(reason instanceof Error ? reason.message : "Unable to read job status.")),
      650
    );
    return () => window.clearInterval(timer);
  }, [job]);
  const busy = job && !["complete", "failed"].includes(job.status),
    rejected = job?.result?.selection.rejected.length ?? 0,
    currentTrip = reviewTrip ?? (job?.result ? { slug: slugFromPath(job.result.path), manifest: job.result.manifest } : undefined),
    currentManifest = draft ?? currentTrip?.manifest;
  const phase = currentManifest ? "complete" : busy ? "working" : "setup";
  const displayedError = job?.status === "failed" ? (job.error ?? "Trip generation failed.") : error;
  const canBuild = connection === "ready" && folder.trim().length > 0 && !busy && !(people === "exclude" && !status?.openaiConfigured);

  async function chooseFolder() {
    setError("");
    setPicking(true);
    try {
      const value = await api<{ path: string }>("/api/folders/pick", { method: "POST" });
      setFolder(value.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Folder selection was cancelled.");
    } finally {
      setPicking(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canBuild) return;
    setError("");
    setJob(undefined);
    setReviewTrip(undefined);
    setDraft(undefined);
    setRemovedPhotos([]);
    try {
      const value = await api<{ id: string }>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: folder.trim(), title: title.trim() || undefined, people, maxPhotos, privacy }),
      });
      setJob(await api<StudioJob>(`/api/jobs/${value.id}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start Wanderpage.");
    }
  }

  async function loadTrips() {
    const value = await api<{ trips: ManagedTrip[] }>("/api/trips");
    setTrips(value.trips);
  }
  async function openTrip(slug: string) {
    setError("");
    try {
      const value = await api<{ manifest: TripManifest }>(`/api/trips/${slug}`);
      setJob(undefined);
      setReviewTrip({ slug, manifest: value.manifest });
      setDraft(value.manifest);
      setRemovedPhotos([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to open this trip.");
    }
  }
  function updateDraft(update: (value: TripManifest) => TripManifest) {
    if (!currentManifest) return;
    setDraft(update(currentManifest));
  }
  async function persistDraft() {
    if (!currentTrip || !currentManifest) return;
    const value = await api<{ manifest: TripManifest }>(`/api/trips/${currentTrip.slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: { ...currentManifest, published: false } }),
    });
    setReviewTrip({ slug: currentTrip.slug, manifest: value.manifest });
    setDraft(value.manifest);
    await loadTrips();
  }
  async function saveDraft() {
    setSaving(true);
    setError("");
    try {
      await persistDraft();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save this draft.");
    } finally {
      setSaving(false);
    }
  }
  async function changePublication(published: boolean) {
    if (!currentTrip || !currentManifest) return;
    setSaving(true);
    setError("");
    try {
      if (published) await persistDraft();
      const value = await api<{ manifest: TripManifest }>(`/api/trips/${currentTrip.slug}/${published ? "publish" : "unpublish"}`, {
        method: "POST",
      });
      setReviewTrip({ slug: currentTrip.slug, manifest: value.manifest });
      setDraft(value.manifest);
      await loadTrips();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update publishing state.");
    } finally {
      setSaving(false);
    }
  }
  async function removeCurrentTrip() {
    if (
      !currentTrip ||
      !confirm(`Delete “${currentManifest?.title ?? currentTrip.slug}”? This removes its local manifest, not your originals.`)
    )
      return;
    setSaving(true);
    try {
      await api(`/api/trips/${currentTrip.slug}`, { method: "DELETE" });
      setJob(undefined);
      setReviewTrip(undefined);
      setDraft(undefined);
      setRemovedPhotos([]);
      await loadTrips();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete this trip.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="studio-page">
      <aside className="studio-atmosphere" aria-hidden="true">
        <div className="studio-atmosphere-media">
          <Image src="/trip/demo/coast-hero-large.webp" alt="" fill priority loading="eager" sizes="38vw" />
        </div>
        <div className="studio-roll-meta">
          <span>WP / LOCAL EDIT</span>
          <span>ROLL 001</span>
        </div>
        <div className="studio-route-mark">
          <i />
          <i />
          <i />
          <span>folder</span>
          <span>edit</span>
          <span>story</span>
        </div>
        <div className="studio-atmosphere-copy">
          <span>Wanderpage Studio</span>
          <p>
            Your originals stay here.
            <br />
            Only the edit travels.
          </p>
        </div>
      </aside>
      <section className="studio-workspace">
        <header className="studio-header">
          <Link href="/" className="studio-wordmark">
            Wanderpage <small>Studio desk / 01</small>
          </Link>
          <div className={`studio-connection ${connection}`}>
            <i />
            {connection === "ready" ? "Local engine ready" : connection === "checking" ? "Finding local engine" : "Start with pnpm studio"}
          </div>
        </header>
        <div className="studio-body">
          <nav className="studio-phases" aria-label="Creation progress">
            <Phase index="01" label="Set up" active={phase === "setup"} done={phase !== "setup"} />
            <Phase index="02" label="Edit" active={phase === "working"} done={phase === "complete"} />
            <Phase index="03" label="Review" active={phase === "complete"} done={false} />
          </nav>
          <div className="studio-docket" aria-hidden="true">
            <span>LOCAL WORK ORDER</span>
            <span>
              {job?.status === "failed"
                ? "EDIT FAILED"
                : phase === "setup"
                  ? "AWAITING SOURCE"
                  : phase === "working"
                    ? "EDIT IN PROGRESS"
                    : "PROOF READY"}
            </span>
          </div>
          <AnimatePresence mode="wait">
            {phase === "setup" && (
              <motion.div
                className="studio-panel"
                key="setup"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
              >
                <div className="studio-title">
                  <span className="eyebrow">New story</span>
                  <h1>
                    Choose the trip
                    <br />
                    <em>worth keeping.</em>
                  </h1>
                  <p>Wanderpage will score, edit, and arrange the strongest frames. It may leave photos out.</p>
                </div>
                <form className="studio-form" onSubmit={submit}>
                  <label className="studio-field studio-folder">
                    <span>Photo folder</span>
                    <div>
                      <input
                        value={folder}
                        onChange={event => setFolder(event.target.value)}
                        placeholder="Choose a folder or paste its absolute path"
                        required
                        aria-label="Photo folder path"
                      />
                      <button type="button" onClick={() => void chooseFolder()} disabled={connection !== "ready" || picking}>
                        {picking ? "Choosing…" : "Choose folder"}
                      </button>
                    </div>
                  </label>
                  <label className="studio-field">
                    <span>
                      Story title <small>Optional</small>
                    </span>
                    <input
                      value={title}
                      onChange={event => setTitle(event.target.value)}
                      placeholder="Late September in Portugal"
                      maxLength={120}
                    />
                  </label>
                  <fieldset className="studio-field studio-choice">
                    <legend>People in the published story</legend>
                    <div>
                      <Choice
                        label="Include"
                        detail="People may appear; nobody is identified."
                        checked={people === "include"}
                        onChange={() => setPeople("include")}
                      />
                      <Choice
                        label="Exclude"
                        detail={status?.openaiConfigured ? "Remove every frame with a visible person." : "Requires an OpenAI API key."}
                        checked={people === "exclude"}
                        disabled={!status?.openaiConfigured}
                        onChange={() => setPeople("exclude")}
                      />
                    </div>
                  </fieldset>
                  <fieldset className="studio-field studio-choice">
                    <legend>Map precision</legend>
                    <div>
                      <Choice
                        label="Approximate"
                        detail="Recommended. Broader public route."
                        checked={privacy === "approximate"}
                        onChange={() => setPrivacy("approximate")}
                      />
                      <Choice
                        label="Closer"
                        detail="Still rounded; never exact GPS."
                        checked={privacy === "exact"}
                        onChange={() => setPrivacy("exact")}
                      />
                    </div>
                  </fieldset>
                  <label className="studio-field studio-range">
                    <span>
                      Maximum edit <strong>{maxPhotos} photos</strong>
                    </span>
                    <input
                      type="range"
                      min="12"
                      max="60"
                      step="4"
                      value={maxPhotos}
                      onChange={event => setMaxPhotos(Number(event.target.value))}
                    />
                    <small>Wanderpage can use fewer when the edit is stronger.</small>
                  </label>
                  {displayedError && (
                    <p className="studio-error" role="alert">
                      {displayedError}
                    </p>
                  )}
                  <button className="studio-build" type="submit" disabled={!canBuild}>
                    <span>Build my Wanderpage</span>
                    <b>→</b>
                  </button>
                </form>
                {trips.length > 0 && (
                  <section className="studio-library" aria-labelledby="trip-library-title">
                    <span className="eyebrow">Your local library</span>
                    <h2 id="trip-library-title">Past edits</h2>
                    {trips.map(trip => (
                      <button key={trip.slug} type="button" onClick={() => void openTrip(trip.slug)}>
                        <span>{trip.manifest.published ? "Published" : "Draft"}</span>
                        <b>{trip.manifest.title}</b>
                        <small>{trip.manifest.photos.length} selected frames</small>
                      </button>
                    ))}
                  </section>
                )}
              </motion.div>
            )}
            {phase === "working" && job && (
              <motion.div
                className="studio-panel studio-working"
                key="working"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="studio-title">
                  <span className="eyebrow">Editing locally</span>
                  <h1>{job.progress.message}</h1>
                  <p>You can leave this window open. Originals are read only and the website receives metadata-free copies.</p>
                </div>
                <div className="studio-progress" aria-live="polite">
                  <div className="studio-progress-number">
                    {job.progress.progress}
                    <span>%</span>
                  </div>
                  <div className="studio-progress-track">
                    <motion.i animate={{ width: `${job.progress.progress}%` }} transition={{ ease: [0.2, 0.7, 0.2, 1], duration: 0.45 }} />
                  </div>
                  <div className="studio-progress-meta">
                    <span>{job.progress.stage}</span>
                    <span>{folderName(folder)}</span>
                  </div>
                </div>
              </motion.div>
            )}
            {phase === "complete" && currentTrip && currentManifest && (
              <motion.div
                className="studio-panel studio-complete"
                key="complete"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="studio-title">
                  <span className="eyebrow">{currentManifest.published ? "Published story" : "Draft ready for review"}</span>
                  <h1>{currentManifest.title}</h1>
                  <p>
                    {currentManifest.photos.length} selected · {rejected} left out ·{" "}
                    {numberValue(job?.result?.summary ?? {}, "duplicatesRemoved")} duplicates removed
                  </p>
                </div>
                <div className="studio-review-strip">
                  {currentManifest.photos.slice(0, 5).map((photo, index) => (
                    <motion.div
                      key={photo.id}
                      initial={{ opacity: 0, y: 14 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.08 }}
                    >
                      <Image
                        src={studioImageSrc(currentTrip.slug, currentManifest.published, photo.srcThumb)}
                        alt={photo.alt}
                        width={photo.width}
                        height={photo.height}
                      />
                    </motion.div>
                  ))}
                </div>
                <section className="studio-evidence" aria-label="Privacy and evidence review">
                  <div>
                    <span>Privacy check</span>
                    <b>{job?.result?.review?.privacy.passed === false ? "Needs attention" : "Passed"}</b>
                    <small>Metadata, local paths, and configured secrets are checked before a static build is served.</small>
                  </div>
                  <div>
                    <span>People setting</span>
                    <b>{currentManifest.peopleMode === "exclude" ? "Excluded" : "May appear"}</b>
                    <small>{rejected} frames left out by the edit.</small>
                  </div>
                  <div>
                    <span>Location evidence</span>
                    <b>{currentManifest.destinations.length} approximate stops</b>
                    <small>
                      {currentManifest.sources.length} supporting source{currentManifest.sources.length === 1 ? "" : "s"} retained locally.
                    </small>
                  </div>
                </section>
                {!currentManifest.published && (
                  <section className="studio-editor" aria-labelledby="editor-title">
                    <span className="eyebrow">Owner’s edit</span>
                    <h2 id="editor-title">Make this story yours</h2>
                    <label>
                      Title
                      <input
                        value={currentManifest.title}
                        maxLength={120}
                        onChange={event => updateDraft(value => ({ ...value, title: event.target.value }))}
                      />
                    </label>
                    <label>
                      Subtitle
                      <input
                        value={currentManifest.subtitle}
                        maxLength={220}
                        onChange={event => updateDraft(value => ({ ...value, subtitle: event.target.value }))}
                      />
                    </label>
                    <label>
                      Opening note
                      <textarea
                        value={currentManifest.opening}
                        maxLength={800}
                        onChange={event => updateDraft(value => ({ ...value, opening: event.target.value }))}
                      />
                    </label>
                    <label>
                      Closing note
                      <textarea
                        value={currentManifest.closing}
                        maxLength={800}
                        onChange={event => updateDraft(value => ({ ...value, closing: event.target.value }))}
                      />
                    </label>
                    <div className="studio-chapter-editor">
                      <span>Chapters</span>
                      {currentManifest.chapters.map(chapter => (
                        <div key={chapter.id}>
                          <input
                            aria-label={`Title for ${chapter.id}`}
                            value={chapter.title}
                            maxLength={120}
                            onChange={event =>
                              updateDraft(value => ({
                                ...value,
                                chapters: value.chapters.map(item =>
                                  item.id === chapter.id ? { ...item, title: event.target.value } : item
                                ),
                              }))
                            }
                          />
                          <textarea
                            aria-label={`Narrative for ${chapter.id}`}
                            value={chapter.narrative}
                            maxLength={1200}
                            onChange={event =>
                              updateDraft(value => ({
                                ...value,
                                chapters: value.chapters.map(item =>
                                  item.id === chapter.id ? { ...item, narrative: event.target.value } : item
                                ),
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                    {currentManifest.destinations.length > 0 && (
                      <div className="studio-destination-editor">
                        <span>Approximate route stops</span>
                        {currentManifest.destinations.map(destination => (
                          <button
                            key={destination.id}
                            type="button"
                            onClick={() =>
                              updateDraft(value => ({
                                ...value,
                                destinations: value.destinations.filter(item => item.id !== destination.id),
                                route: value.route.filter(item => item.destinationId !== destination.id),
                                photos: value.photos.map(photo =>
                                  photo.destinationId === destination.id ? { ...photo, destinationId: undefined } : photo
                                ),
                                chapters: value.chapters.map(chapter =>
                                  chapter.destinationId === destination.id ? { ...chapter, destinationId: undefined } : chapter
                                ),
                              }))
                            }
                          >
                            Remove {destination.name} from the public route
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="studio-photo-editor">
                      <span>Selected frames</span>
                      {currentManifest.photos.map((photo, index) => (
                        <article key={photo.id}>
                          <Image
                            src={studioImageSrc(currentTrip.slug, currentManifest.published, photo.srcThumb)}
                            alt={photo.alt}
                            width={96}
                            height={72}
                          />
                          <div>
                            <input
                              aria-label={`Caption for ${photo.alt}`}
                              value={photo.caption ?? ""}
                              maxLength={320}
                              onChange={event =>
                                updateDraft(value => ({
                                  ...value,
                                  photos: value.photos.map(item =>
                                    item.id === photo.id ? { ...item, caption: event.target.value || undefined } : item
                                  ),
                                }))
                              }
                            />
                            <small>{photo.id === currentManifest.heroPhotoId ? "Hero frame" : "Selected frame"}</small>
                          </div>
                          <div className="studio-photo-actions">
                            <button type="button" onClick={() => updateDraft(value => ({ ...value, heroPhotoId: photo.id }))}>
                              Hero
                            </button>
                            <button
                              type="button"
                              disabled={index === 0}
                              onClick={() => updateDraft(value => reorderPhoto(value, index, index - 1))}
                            >
                              Earlier
                            </button>
                            <button
                              type="button"
                              disabled={index === currentManifest.photos.length - 1}
                              onClick={() => updateDraft(value => reorderPhoto(value, index, index + 1))}
                            >
                              Later
                            </button>
                            <button
                              type="button"
                              disabled={currentManifest.photos.length === 1}
                              onClick={() => {
                                setRemovedPhotos(value => [...value, photo]);
                                updateDraft(value => ({ ...value, photos: value.photos.filter(item => item.id !== photo.id) }));
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                    {removedPhotos.length > 0 && (
                      <div className="studio-restore">
                        <span>Removed in this review</span>
                        {removedPhotos.map(photo => (
                          <button
                            key={photo.id}
                            type="button"
                            onClick={() => {
                              updateDraft(value => ({ ...value, photos: [...value.photos, photo] }));
                              setRemovedPhotos(value => value.filter(item => item.id !== photo.id));
                            }}
                          >
                            Restore {photo.alt}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                <div className="studio-result-actions">
                  {!currentManifest.published && (
                    <button className="studio-build" type="button" disabled={saving} onClick={() => void changePublication(true)}>
                      <span>{saving ? "Saving…" : "Publish this story"}</span>
                      <b>→</b>
                    </button>
                  )}
                  {currentManifest.published && (
                    <a className="studio-build" href={`/trips/${currentTrip.slug}`} target="_blank" rel="noreferrer">
                      <span>Open published story</span>
                      <b>↗</b>
                    </a>
                  )}
                  {!currentManifest.published && (
                    <button type="button" disabled={saving} onClick={() => void saveDraft()}>
                      Save draft
                    </button>
                  )}
                  {currentManifest.published && (
                    <button type="button" disabled={saving} onClick={() => void changePublication(false)}>
                      Unpublish
                    </button>
                  )}
                  <a href={`/report/${currentTrip.slug}`} target="_blank" rel="noreferrer">
                    Review every decision
                  </a>
                  <button type="button" disabled={saving} onClick={() => void removeCurrentTrip()}>
                    Delete trip
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setJob(undefined);
                      setReviewTrip(undefined);
                      setDraft(undefined);
                      setRemovedPhotos([]);
                      setError("");
                    }}
                  >
                    Make another
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {phase !== "setup" && displayedError && (
            <p className="studio-error" role="alert">
              {displayedError}
            </p>
          )}
        </div>
        <footer className="studio-footer">
          <span>Local-first photo editing</span>
          <span>No identity recognition · No exact GPS · Originals untouched</span>
        </footer>
      </section>
    </main>
  );
}

function Phase({ index, label, active, done }: { index: string; label: string; active: boolean; done: boolean }) {
  return (
    <div className={active ? "active" : done ? "done" : ""}>
      <span>{done ? "✓" : index}</span>
      <b>{label}</b>
    </div>
  );
}
function Choice({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label className={disabled ? "disabled" : ""}>
      <input type="radio" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <b>{label}</b>
        <small>{detail}</small>
      </span>
    </label>
  );
}
function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Photo folder";
}
function numberValue(summary: Record<string, unknown>, key: string) {
  const value = summary[key];
  return typeof value === "number" ? value : 0;
}
function slugFromPath(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}
function move<T>(items: T[], from: number, to: number) {
  const copy = [...items],
    [item] = copy.splice(from, 1);
  if (item === undefined) return items;
  copy.splice(to, 0, item);
  return copy;
}
function reorderPhoto(manifest: TripManifest, from: number, to: number) {
  const photos = move(manifest.photos, from, to),
    orderedIds = photos.map(photo => photo.id),
    rank = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...manifest,
    photos,
    chapters: manifest.chapters.map(chapter => ({
      ...chapter,
      photoIds: [...chapter.photoIds].sort((left, right) => (rank.get(left) ?? Infinity) - (rank.get(right) ?? Infinity)),
    })),
  };
}
function studioImageSrc(slug: string, published: boolean, source: string) {
  if (published) return source;
  const asset = source.split("/").at(-1);
  return asset ? `/api/trips/${slug}/assets/${asset}` : source;
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}
