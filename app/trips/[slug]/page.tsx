import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Story from "@/components/Story";
import { TripManifestSchema } from "@/lib/schemas/trip";

const directory=join(process.env.WANDERPAGE_WORKSPACE??process.cwd(),"data/trips");

export const dynamicParams=false;
export async function generateStaticParams(){const params=(await tripFiles()).map((file)=>({slug:file.slice(0,-5)}));return params.length?params:[{slug:"placeholder"}];}
export async function generateMetadata({params}:{params:Promise<{slug:string}>}):Promise<Metadata>{const {slug}=await params,trip=await loadTrip(slug);return trip?{title:`${trip.title} — Wanderpage`,description:trip.subtitle}:{};}
export default async function TripPage({params}:{params:Promise<{slug:string}>}){const {slug}=await params,trip=await loadTrip(slug);if(!trip)notFound();return <Story trip={trip}/>;}

async function tripFiles(){return readdir(directory).then((files)=>files.filter((file)=>file.endsWith(".json")).sort()).catch(()=>[]);}
async function loadTrip(slug:string){if(!/^[a-z0-9-]+$/.test(slug))return undefined;return readFile(join(directory,`${slug}.json`),"utf8").then((value)=>TripManifestSchema.parse(JSON.parse(value))).catch(()=>undefined);}
