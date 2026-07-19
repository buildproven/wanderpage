"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import Link from "next/link";

const reveal = {
  initial: { opacity: 0, y: 32 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.22 },
  transition: { duration: 0.75, ease: [0.2, 0.7, 0.2, 1] as const },
};

export default function Landing() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const heroScale = useTransform(scrollYProgress, [0, 0.2], [1, reduce ? 1 : 1.07]);

  return (
    <main className="product-page">
      <section className="product-hero" aria-labelledby="product-title">
        <motion.div className="product-hero-media" style={{ scale: heroScale }}>
          <Image src="/trip/demo/coast-hero-large.webp" alt="A long Pacific beach beneath coastal headlands" fill priority sizes="100vw" />
        </motion.div>
        <nav className="product-nav" aria-label="Primary navigation">
          <span className="product-wordmark">Wanderpage</span>
          <Link href="/demo" className="product-nav-link">
            View the demo ↗
          </Link>
        </nav>
        <motion.div
          className="product-hero-copy"
          initial={{ opacity: 0, y: 25 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9 }}
        >
          <p className="product-kicker">Your photos · one finished story</p>
          <h1 id="product-title">
            Your trip,
            <br />
            <em>beautifully edited.</em>
          </h1>
          <p className="product-summary">
            Wanderpage turns a folder of vacation photos into a cinematic website—kept local until you choose to share it.
          </p>
          <Link href="/demo" className="product-cta">
            Explore a finished story <span>→</span>
          </Link>
        </motion.div>
        <div className="product-hero-note">
          <span>Local-first</span>
          <span>Originals untouched</span>
          <span>Share when ready</span>
        </div>
      </section>

      <section className="product-premise" aria-labelledby="premise-title">
        <motion.div {...reveal}>
          <p className="product-kicker">What Wanderpage does</p>
          <h2 id="premise-title">
            A camera roll is evidence.
            <br />
            <em>Wanderpage finds the story.</em>
          </h2>
        </motion.div>
        <motion.p {...reveal}>
          It reads dates and approximate places, removes duplicates, filters weak frames, and selects a varied sequence. Then it writes
          restrained context, builds the route, strips private metadata, and exports a static site ready to share.
        </motion.p>
      </section>

      <section className="product-process" aria-labelledby="process-title">
        <div className="product-process-sticky">
          <p className="product-kicker">One folder in</p>
          <h2 id="process-title">
            No selecting.
            <br />
            No captioning.
            <br />
            No designing.
          </h2>
          <p>Keep control of who appears. Wanderpage handles the edit.</p>
        </div>
        <div className="product-steps">
          <motion.article {...reveal}>
            <span>01</span>
            <div>
              <h3>Choose the folder</h3>
              <p>JPEG, PNG, WebP, and iPhone HEIC photos can stay exactly where they are.</p>
            </div>
            <Image
              src="/trip/demo/headland-medium.webp"
              alt="An empty trail above the Pacific"
              width={900}
              height={675}
              sizes="(max-width: 760px) 92vw, 45vw"
            />
          </motion.article>
          <motion.article {...reveal}>
            <span>02</span>
            <div>
              <h3>Set the boundary</h3>
              <p>Include people, or exclude every frame where a person is visible. No names. No face identification.</p>
            </div>
            <Image
              src="/trip/demo/tidepool-medium.webp"
              alt="Tide pools among dark coastal rocks"
              width={900}
              height={675}
              sizes="(max-width: 760px) 92vw, 45vw"
            />
          </motion.article>
          <motion.article {...reveal}>
            <span>03</span>
            <div>
              <h3>Receive the story</h3>
              <p>A responsive photo essay with chapters, route, facts, gallery, credits, and a static export you control.</p>
            </div>
            <Image
              src="/trip/demo/cabin-medium.webp"
              alt="The ocean seen through a warm cabin window"
              width={900}
              height={600}
              sizes="(max-width: 760px) 92vw, 45vw"
            />
          </motion.article>
        </div>
      </section>

      <section className="product-privacy" aria-labelledby="privacy-title">
        <div>
          <p className="product-kicker">Privacy is the architecture</p>
          <h2 id="privacy-title">
            The originals
            <br />
            <em>never leave home.</em>
          </h2>
        </div>
        <div className="product-privacy-list">
          <p>
            <span>01</span> Originals stay untouched on your computer.
          </p>
          <p>
            <span>02</span> Only reduced analysis sheets reach the vision model.
          </p>
          <p>
            <span>03</span> Exact GPS and camera metadata are removed before publishing.
          </p>
          <p>
            <span>04</span> The public site contains selected, optimized images only.
          </p>
        </div>
      </section>

      <section className="product-proof">
        <Image src="/trip/demo/coast-hero-large.webp" alt="Golden light along the Pacific coast" fill sizes="100vw" />
        <div>
          <p className="product-kicker">See the complete result</p>
          <h2>
            Four days.
            <br />
            Eight frames.
            <br />
            <em>One finished story.</em>
          </h2>
          <Link href="/demo" className="product-cta product-cta-light">
            Open “A Line Along the Pacific” <span>→</span>
          </Link>
        </div>
      </section>

      <footer className="product-footer">
        <span className="product-wordmark">Wanderpage</span>
        <p>Private by default. Shared by choice.</p>
        <Link href="/demo">View demo ↗</Link>
      </footer>
    </main>
  );
}
