"use client";

import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TripManifest } from "@/lib/schemas/trip";

const reveal = {
  initial: { opacity: 0, y: 35 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.16 },
  transition: { duration: 0.75, ease: [0.2, 0.7, 0.2, 1] as const },
};
const MotionImage = motion.create(Image);

export default function Story({ trip }: { trip: TripManifest }) {
  const [active, setActive] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const heroScale = useTransform(scrollYProgress, [0, 0.18], [1, reduce ? 1 : 1.08]);
  const photos = useMemo(() => new Map(trip.photos.map(photo => [photo.id, photo])), [trip.photos]);
  const gallery = trip.photos.filter(photo => photo.source === "user");
  const close = useCallback(() => setActive(null), []);
  const move = useCallback(
    (delta: number) => setActive(current => (current === null ? null : (current + delta + gallery.length) % gallery.length)),
    [gallery.length]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight") move(1);
      if (event.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, move]);
  useEffect(() => {
    document.body.style.overflow = active === null ? "" : "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [active]);

  const hero = photos.get(trip.heroPhotoId)!;
  return (
    <main>
      <section className="hero" aria-labelledby="trip-title">
        <motion.div className="hero-media" style={{ scale: heroScale }}>
          <Image src={hero.srcLarge} alt={hero.alt} fill priority loading="eager" sizes="100vw" />
        </motion.div>
        <nav className="hero-nav" aria-label="Story navigation">
          <Link className="mark" href="/">
            Wanderpage <small>Field note / travel story</small>
          </Link>
          <a className="eyebrow" href="#story">
            Read the story ↓
          </a>
        </nav>
        <motion.div className="hero-copy" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1 }}>
          <span className="eyebrow">A photographic field note</span>
          <h1 id="trip-title">{trip.title}</h1>
          <div className="hero-meta">
            <span>{trip.dateRange ? `${trip.dateRange.start} — ${trip.dateRange.end}` : ""}</span>
            <span>{trip.destinations.map(d => d.name).join(" · ")}</span>
          </div>
        </motion.div>
        <div className="story-folio" aria-hidden="true">
          <span>01</span>
          <i />
          <span>{trip.photos.length.toString().padStart(2, "0")} selected frames</span>
        </div>
        <span className="scroll-cue">Follow the coastline</span>
      </section>

      <section className="intro" id="story">
        <div>
          <span className="eyebrow">The passage</span>
        </div>
        <blockquote>{trip.opening}</blockquote>
      </section>
      <section className="stats" aria-label="Trip at a glance">
        {trip.stats.map(stat => (
          <div className="stat" key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </div>
        ))}
      </section>

      <section className="route-section" aria-labelledby="route-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">North to south</span>
            <h2 id="route-title">
              The coast,
              <br />
              <em>in four stops.</em>
            </h2>
          </div>
          <p>{trip.subtitle}</p>
        </div>
        <Route trip={trip} />
      </section>

      {trip.chapters.map((chapter, index) => {
        const chapterPhotos = chapter.photoIds.map(id => photos.get(id)).filter(photo => photo !== undefined);
        const destination = trip.destinations.find(item => item.id === chapter.destinationId);
        return (
          <article className="chapter" key={chapter.id}>
            <motion.header className="chapter-heading" {...reveal}>
              <span className="chapter-number">0{index + 1}</span>
              <h2>{chapter.title}</h2>
              <div>
                {destination && <span className="chapter-location">{destination.name} / field entry</span>}
                <p className="chapter-text">{chapter.narrative}</p>
              </div>
            </motion.header>
            <div className={`spread ${index % 2 ? "reverse" : ""}`}>
              {chapterPhotos.slice(0, 2).map((photo, photoIndex) => (
                <motion.figure className={`photo ${photoIndex ? "tall offset" : ""}`} key={photo.id} {...reveal}>
                  <Image
                    src={photo.srcLarge}
                    alt={photo.alt}
                    width={photo.width}
                    height={photo.height}
                    sizes="(max-width: 760px) 92vw, 60vw"
                  />
                  <figcaption>{photo.caption}</figcaption>
                </motion.figure>
              ))}
            </div>
            {destination && destination.facts.length > 0 && (
              <motion.aside className="fact-band" {...reveal}>
                <div>
                  <span className="eyebrow">Field notes · {destination.name}</span>
                </div>
                <div className="facts">
                  {destination.facts.map(fact => (
                    <div className="fact" key={fact.text}>
                      <span className="eyebrow">Observed context</span>
                      <p>{fact.text}</p>
                    </div>
                  ))}
                </div>
              </motion.aside>
            )}
          </article>
        );
      })}

      <section className="gallery" aria-labelledby="gallery-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">The edit</span>
            <h2 id="gallery-title">
              Frames from
              <br />
              <em>the road.</em>
            </h2>
          </div>
          <p>{gallery.length} photographs, arranged in the order they were made.</p>
        </div>
        <div className="gallery-grid">
          {gallery.map((photo, index) => (
            <button className="gallery-button" key={photo.id} onClick={() => setActive(index)} aria-label={`Open photograph: ${photo.alt}`}>
              <Image
                src={photo.srcMedium}
                alt={photo.alt}
                width={photo.width}
                height={photo.height}
                sizes="(max-width: 420px) 94vw, (max-width: 760px) 47vw, 31vw"
              />
            </button>
          ))}
        </div>
      </section>
      <section className="closing">
        <Image src={gallery.at(-1)!.srcLarge} alt={gallery.at(-1)!.alt} fill sizes="100vw" />
        <motion.p {...reveal}>{trip.closing}</motion.p>
      </section>
      <footer className="credits">
        <div className="credits-inner">
          <div>
            <span className="eyebrow">Sources & credits</span>
            <h2 className="serif">
              Made from the road,
              <br />
              grounded in sources.
            </h2>
          </div>
          <div className="source-list">
            {trip.sources.map(source => (
              <div key={source.id}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>{" "}
                · {source.provider}
                {source.license ? ` · ${source.license}` : ""}
              </div>
            ))}
          </div>
        </div>
        <div className="footer-line">
          <span>Wanderpage</span>
          <span>Private photos · public story</span>
        </div>
      </footer>

      <AnimatePresence>
        {active !== null && (
          <motion.div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Photo viewer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="lightbox-top">
              <span>
                {active + 1} / {gallery.length}
              </span>
              <button onClick={close} aria-label="Close lightbox">
                ×
              </button>
            </div>
            <div className="lightbox-media">
              <button onClick={() => move(-1)} aria-label="Previous photo">
                ←
              </button>
              <MotionImage
                key={gallery[active]!.id}
                src={gallery[active]!.srcLarge}
                alt={gallery[active]!.alt}
                width={gallery[active]!.width}
                height={gallery[active]!.height}
                sizes="80vw"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
              />
              <button onClick={() => move(1)} aria-label="Next photo">
                →
              </button>
            </div>
            <p className="lightbox-caption">{gallery[active]!.caption}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function Route({ trip }: { trip: TripManifest }) {
  const points = trip.route.map((point, index) => ({ ...point, x: 90 + index * 300, y: index % 2 ? 185 : 85 }));
  const path = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  return (
    <div className="route-map">
      <svg viewBox="0 0 1100 290" role="img" aria-label={`Approximate route through ${trip.destinations.map(d => d.name).join(", ")}`}>
        <path d="M0 225 C180 120 240 265 420 145 S720 235 1100 40" fill="none" stroke="#495650" strokeWidth="1" />
        <motion.path
          d={path}
          fill="none"
          stroke="#d96b47"
          strokeWidth="3"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 2, ease: "easeInOut" }}
        />
        {points.map(point => {
          const dest = trip.destinations.find(d => d.id === point.destinationId);
          return (
            <g key={point.destinationId}>
              <circle cx={point.x} cy={point.y} r="7" fill="#d96b47" />
              <text x={point.x} y={point.y + 35} textAnchor="middle" className="route-label">
                {dest?.name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
