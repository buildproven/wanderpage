import type { Metadata } from "next";
import WebCreator from "@/components/WebCreator";

export const metadata: Metadata = {
  title: "Create a story — Wanderpage",
  description: "Privately upload travel photos and create a Wanderpage draft in your browser.",
};

export default function CreatePage() {
  return <WebCreator />;
}
