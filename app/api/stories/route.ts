import { z } from "zod";
import { apiError, data, privateHeaders } from "@/lib/web/http";
import { getStoryService } from "@/lib/web/runtime";
import { admissionKey, assertInitialRequest, ownerSecret, setOwnerCookie } from "@/lib/web/session";
import { StoryServiceError } from "@/lib/web/story-service";
import { LocationPrivacyModes, PeopleModes } from "@/lib/web/types";
import { storyDto } from "@/lib/web/dto";

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  peopleMode: z.enum(PeopleModes),
  locationPrivacy: z.enum(LocationPrivacyModes),
  termsVersion: z.string().trim().min(1).max(64),
  uploadConsentVersion: z.string().trim().min(1).max(64),
});

export async function POST(request: Request) {
  try {
    assertInitialRequest(request);
    const input = createSchema.parse(await request.json()),
      stories = getStoryService();
    let secret = await ownerSecret(),
      created;
    try {
      await stories.requireSession(secret);
    } catch (error) {
      if (!(error instanceof StoryServiceError) || error.code !== "AUTH_REQUIRED") throw error;
      created = await stories.createSessionWithStory(input, admissionKey(request));
      secret = created.rawSecret;
    }
    if (!secret) throw new Error("Owner session could not be established.");
    const story = created?.story ?? (await stories.createStory(secret, input, admissionKey(request))),
      session = await stories.requireSession(secret),
      response = data({ story: storyDto(story), csrfToken: session.csrfToken }, 201, { headers: privateHeaders() });
    if (created) setOwnerCookie(response, secret, created.session);
    return response;
  } catch (error) {
    return apiError(error);
  }
}

export async function GET() {
  try {
    const stories = getStoryService(),
      secret = await ownerSecret();
    if (!secret) throw new StoryServiceError("AUTH_REQUIRED", "Start a private Wanderpage story to see your drafts.");
    return data({ stories: (await stories.listOwnedStories(secret)).map(storyDto) }, 200, { headers: privateHeaders() });
  } catch (error) {
    return apiError(error);
  }
}
