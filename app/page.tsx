import Story from "@/components/Story";
import rawManifest from "@/data/trip.json";
import { TripManifestSchema } from "@/lib/schemas/trip";

export default function Home() {
  return <Story trip={TripManifestSchema.parse(rawManifest)} />;
}
