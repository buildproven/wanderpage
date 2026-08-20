import Landing from "@/components/Landing";

export default function Home() {
  return <Landing hostedCreatorEnabled={process.env.WANDERPAGE_GENERATION_ENABLED === "true"} />;
}
