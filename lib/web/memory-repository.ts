import type { OwnerSession, Story, StoryRepository, StoryRun, StoryUpload } from "@/lib/web/types";

export class MemoryStoryRepository implements StoryRepository {
  private readonly sessions = new Map<string, OwnerSession>();
  private readonly sessionsByHash = new Map<string, string>();
  private readonly stories = new Map<string, Story>();
  private readonly runs = new Map<string, StoryRun>();
  private readonly uploads = new Map<string, StoryUpload>();

  async createSession(session: OwnerSession) {
    this.sessions.set(session.id, clone(session));
    this.sessionsByHash.set(session.secretHash, session.id);
  }

  async findSessionBySecretHash(secretHash: string) {
    const id = this.sessionsByHash.get(secretHash);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? clone(session) : undefined;
  }

  async touchSession(id: string, lastSeenAt: Date) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastSeenAt = new Date(lastSeenAt);
  }

  async createStory(story: Story) {
    this.stories.set(story.id, clone(story));
  }

  async findStory(id: string) {
    const story = this.stories.get(id);
    return story ? clone(story) : undefined;
  }

  async findPublishedStoryBySlug(slug: string) {
    const story = [...this.stories.values()].find(value => value.publicSlug === slug && value.status === "published");
    return story ? clone(story) : undefined;
  }

  async listStories(ownerSessionId: string) {
    return [...this.stories.values()]
      .filter(story => story.ownerSessionId === ownerSessionId && !story.deletedAt)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(story => clone(story));
  }

  async saveStory(story: Story, expectedVersion: number) {
    const current = this.stories.get(story.id);
    if (!current || current.version !== expectedVersion) throw new Error("STORY_VERSION_CONFLICT");
    const saved = clone({ ...story, version: expectedVersion + 1 });
    this.stories.set(saved.id, saved);
    return clone(saved);
  }

  async createRun(run: StoryRun) {
    this.runs.set(run.id, clone(run));
  }

  async findRun(id: string) {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  async saveRun(run: StoryRun) {
    this.runs.set(run.id, clone(run));
  }

  async createUpload(upload: StoryUpload) {
    this.uploads.set(upload.id, clone(upload));
  }

  async findUpload(id: string) {
    const upload = this.uploads.get(id);
    return upload ? clone(upload) : undefined;
  }

  async listUploads(storyId: string) {
    return [...this.uploads.values()].filter(upload => upload.storyId === storyId).map(upload => clone(upload));
  }

  async saveUpload(upload: StoryUpload) {
    this.uploads.set(upload.id, clone(upload));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
