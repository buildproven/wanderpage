import type { Metadata } from "next";
import Studio from "@/components/Studio";

export const metadata:Metadata={title:"Studio — Wanderpage",description:"Create a private Wanderpage story from a local photo folder."};
export default function StudioPage(){return <Studio/>;}
