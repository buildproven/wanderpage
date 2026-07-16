import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { ContactSheetAnalysisSchema, type PhotoSemanticAnalysis } from "@/lib/schemas/analysis";

export interface AIProvider {
  analyzeContactSheet(path: string, photoIds: string[]): Promise<PhotoSemanticAnalysis[]>;
  generateNarrative(context: string): Promise<Narrative>;
}
const NarrativeSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  opening: z.string(),
  closing: z.string(),
  chapterNarratives: z.array(z.string()),
  captions: z.array(z.object({ photoId: z.string(), alt: z.string(), caption: z.string() })),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

export class OpenAIProvider implements AIProvider {
  private client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  async analyzeContactSheet(path: string, photoIds: string[]) {
    const image = (await readFile(path)).toString("base64");
    const response = await retry(() =>
      this.client.responses.parse({
        model: process.env.OPENAI_VISION_MODEL ?? "gpt-5.6-luna",
        input: [
          {
            role: "system",
            content:
              "Analyze only visible evidence in the labeled contact sheet. Return one result per supplied ID. Never identify people or infer identity, relationship, sensitive traits, emotions, or exact location without visible evidence. Location suggestions are hypotheses with concise evidence.",
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: `Photo IDs: ${photoIds.join(", ")}. Score each visible tile.` },
              { type: "input_image", image_url: `data:image/jpeg;base64,${image}`, detail: "high" },
            ],
          },
        ],
        text: { format: zodTextFormat(ContactSheetAnalysisSchema, "contact_sheet_analysis") },
      })
    );
    return ContactSheetAnalysisSchema.parse(response.output_parsed).photos;
  }
  async generateNarrative(context: string) {
    const response = await retry(() =>
      this.client.responses.parse({
        model: process.env.OPENAI_WRITER_MODEL ?? "gpt-5.6-terra",
        input: [
          {
            role: "system",
            content:
              "Write concise factual travel editorial copy using only supplied evidence. Never invent memories, feelings, people, activities, or locations. Avoid clichés including unforgettable journey, hidden gem, and breathtaking. Alt text must describe only visible content.",
          },
          { role: "user", content: context },
        ],
        text: { format: zodTextFormat(NarrativeSchema, "trip_narrative") },
      })
    );
    return NarrativeSchema.parse(response.output_parsed);
  }
}

export class MockAIProvider implements AIProvider {
  async analyzeContactSheet(_path: string, photoIds: string[]) {
    return photoIds.map((photoId, index) => ({
      photoId,
      containsPeople: false,
      peopleProminence: "none" as const,
      aestheticScore: 78 + (index % 4) * 3,
      storyScore: 72 + (index % 5) * 4,
      landmarkValue: 55 + (index % 3) * 8,
      emotionalValue: 40,
      uniquenessScore: 70 + (index % 6) * 4,
      categories: [index % 3 === 0 ? ("landscape" as const) : index % 3 === 1 ? ("detail" as const) : ("architecture" as const)],
      possibleLocations: [],
      captionSeed: "A quiet frame from the route.",
    }));
  }
  async generateNarrative(context: string) {
    void context;
    return {
      title: "A Story From the Road",
      subtitle: "A photographic route assembled from time, place, and visible detail.",
      opening: "The photographs trace a route through changing light and landscape, ordered by the evidence recorded along the way.",
      closing: "The final frame leaves the road where the light ended.",
      chapterNarratives: ["A sequence of places and details, kept in the order they appeared."],
      captions: [],
    };
  }
}
async function retry<T>(task: () => Promise<T>, attempts = 3) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** i));
    }
  }
  throw last;
}
