// @design DES-SITE-HOME
export type StoryIndexItem = { slug: string; title: string; subtitle: string; image?: string };

/** The home page of a site with several published stories. Plain server markup: no client script is needed on a static host. */
export default function StoryIndex({ stories }: { stories: StoryIndexItem[] }) {
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "4rem 1.5rem", fontFamily: "var(--font-sans)" }}>
      <h1 style={{ fontFamily: "var(--font-editorial)", fontSize: "clamp(2.2rem, 6vw, 3.6rem)", fontWeight: 400, margin: "0 0 2.5rem" }}>
        Trip stories
      </h1>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {stories.map(story => (
          <li key={story.slug}>
            <a href={`/trips/${story.slug}`} style={{ display: "block", color: "inherit", textDecoration: "none" }}>
              <div
                role="img"
                aria-label={`Cover photo for ${story.title}`}
                style={{
                  aspectRatio: "4 / 3",
                  background: story.image ? `#d8d2c4 url(${story.image}) center / cover no-repeat` : "#d8d2c4",
                  marginBottom: "0.9rem",
                }}
              />
              <h2 style={{ fontFamily: "var(--font-editorial)", fontSize: "1.5rem", fontWeight: 400, margin: "0 0 0.3rem" }}>
                {story.title}
              </h2>
              <p style={{ margin: 0, opacity: 0.75, lineHeight: 1.45 }}>{story.subtitle}</p>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
