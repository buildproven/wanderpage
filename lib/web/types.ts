import type { TripManifest } from "@/lib/schemas/trip";

export const StoryStatuses = ["uploading", "queued", "processing", "draft", "published", "failed", "deleting", "deleted"] as const;
export type StoryStatus = (typeof StoryStatuses)[number];

export const PeopleModes = ["include", "exclude"] as const;
export type PeopleMode = (typeof PeopleModes)[number];

export const LocationPrivacyModes = ["broad", "approximate", "hidden"] as const;
export type LocationPrivacyMode = (typeof LocationPrivacyModes)[number];

export type OwnerSession = {
  id: string;
  secretHash: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  termsVersion: string;
  uploadConsentVersion: string;
};

export type Story = {
  id: string;
  ownerSessionId: string;
  admissionKey?: string;
  publicSlug?: string;
  status: StoryStatus;
  title: string;
  peopleMode: PeopleMode;
  locationPrivacy: LocationPrivacyMode;
  manifest?: TripManifest;
  processorRevision: string;
  activeRunId?: string;
  sourceExpiresAt: Date;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deleteAfter?: Date;
  deletedAt?: Date;
  version: number;
};

export type StoryRun = {
  id: string;
  storyId: string;
  workflowRunId?: string;
  processorRevision: string;
  admissionKey?: string;
  admittedAt: Date;
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  stage: string;
  progress: number;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: Date;
  finishedAt?: Date;
  derivativesDeletedAt?: Date;
  sourceUploadIds: string[];
  updatedAt: Date;
};

export type StoryUpload = {
  id: string;
  storyId: string;
  blobPath: string;
  originalName: string;
  declaredType: "image/jpeg" | "image/png" | "image/webp";
  detectedType?: string;
  byteSize?: number;
  sha256?: string;
  status: "reserved" | "confirmed" | "rejected" | "deleted";
  createdAt: Date;
  confirmedAt?: Date;
  cleanupClaimedAt?: Date;
  deletedAt?: Date;
};

export type CreateStoryInput = {
  title: string;
  peopleMode: PeopleMode;
  locationPrivacy: LocationPrivacyMode;
  termsVersion: string;
  uploadConsentVersion: string;
};

export type StoryRepository = {
  createSession(session: OwnerSession): Promise<void>;
  createSessionAndStoryAdmitted(session: OwnerSession, story: Story, limits: StoryCreationLimits): Promise<void>;
  findSessionBySecretHash(secretHash: string): Promise<OwnerSession | undefined>;
  renewSession(secretHash: string, now: Date, expiresAt: Date): Promise<OwnerSession | undefined>;
  createStory(story: Story): Promise<void>;
  createStoryAdmitted(story: Story, limits: StoryCreationLimits): Promise<void>;
  findStory(id: string): Promise<Story | undefined>;
  findPublishedStoryBySlug(slug: string): Promise<Story | undefined>;
  listStories(ownerSessionId: string): Promise<Story[]>;
  saveStory(story: Story, expectedVersion: number): Promise<Story>;
  queueRun(story: Story, run: StoryRun, limits: GenerationLimits): Promise<Story>;
  createRun(run: StoryRun): Promise<void>;
  findRun(id: string): Promise<StoryRun | undefined>;
  saveRun(run: StoryRun): Promise<void>;
  setWorkflowRunId(runId: string, workflowRunId: string, now: Date): Promise<void>;
  markRunProgress(storyId: string, runId: string, stage: string, progress: number, now: Date): Promise<void>;
  completeRun(story: Story, run: StoryRun, manifest: TripManifest, now: Date): Promise<void>;
  claimRun(storyId: string, runId: string, now: Date): Promise<{ story: Story; run: StoryRun }>;
  beginDeleteStory(storyId: string, ownerSessionId: string, now: Date): Promise<Story>;
  beginOperatorDeleteStory(storyId: string, now: Date): Promise<Story>;
  finishDeleteStory(storyId: string, now: Date): Promise<void>;
  listRuns(storyId: string): Promise<StoryRun[]>;
  listUploadsByIds(ids: string[]): Promise<StoryUpload[]>;
  expireStaleRuns(now: Date, staleBefore: Date, limit: number): Promise<StoryRun[]>;
  claimExpiredPrivateStories(now: Date, staleBefore: Date, limit: number): Promise<Story[]>;
  listStoriesReadyForDeletion(now: Date, limit: number): Promise<Story[]>;
  purgeDeletedStories(deletedBefore: Date, limit: number): Promise<number>;
  clearExpiredAdmissionKeys(before: Date): Promise<number>;
  listRunsForDerivativeCleanup(limit: number): Promise<StoryRun[]>;
  markRunDerivativesDeleted(runId: string, now: Date): Promise<void>;
  createUpload(upload: StoryUpload): Promise<void>;
  reserveUpload(upload: StoryUpload, limits: UploadLimits): Promise<void>;
  findUpload(id: string): Promise<StoryUpload | undefined>;
  listUploads(storyId: string): Promise<StoryUpload[]>;
  claimExpiredSourceUploads(now: Date, limit: number): Promise<StoryUpload[]>;
  saveUpload(upload: StoryUpload): Promise<void>;
  confirmUpload(upload: StoryUpload): Promise<void>;
};

export type GenerationLimits = {
  sessionStarts: number;
  clientStarts: number;
  globalStarts: number;
  since: Date;
  now: Date;
  minPhotos: number;
};

export type UploadLimits = {
  maxPhotos: number;
  maxBytes: number;
};

export type StoryCreationLimits = {
  sessionStories: number;
  clientStories: number;
  since: Date;
};

export type StoryRunner = {
  start(storyId: string, runId: string): Promise<{ workflowRunId: string }>;
};
