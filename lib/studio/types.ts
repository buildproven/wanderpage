import type { TripManifest } from "@/lib/schemas/trip";

export type StudioJobRequest={input:string;title?:string;people:"include"|"exclude";maxPhotos:number;privacy:"approximate"|"exact"};
export type StudioProgress={stage:string;progress:number;message:string;at:string};
export type StudioSelection={selected:string[];rejected:Array<{id:string;reason?:string}>;reasons:Record<string,string>};
export type StudioJobResult={path:string;summary:Record<string,unknown>;manifest:TripManifest;selection:StudioSelection};
export type StudioJob={id:string;status:"queued"|"running"|"building"|"complete"|"failed";createdAt:string;updatedAt:string;request:StudioJobRequest;progress:StudioProgress;result?:StudioJobResult;error?:string};
export type StudioStatus={ready:true;openaiConfigured:boolean;platform:string;activeJobId?:string};
