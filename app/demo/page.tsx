import type { Metadata } from "next";
import Story from "@/components/Story";
import rawManifest from "@/data/trip.demo.json";
import { TripManifestSchema } from "@/lib/schemas/trip";

export const metadata: Metadata = {
  title: "A Line Along the Pacific — Wanderpage Demo",
  description: "A complete Wanderpage story generated from a folder of travel photographs.",
};

export default function DemoPage() {
  return <Story trip={TripManifestSchema.parse(rawManifest)} />;
}
