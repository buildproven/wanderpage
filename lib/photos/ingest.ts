import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import exifr from "exifr";
import pLimit from "p-limit";
import sharp from "sharp";
import { perceptualHash, technicalScores } from "./scoring";
import type { PhotoRecord } from "./types";

const execute=promisify(execFile); const extensions=new Set([".jpg",".jpeg",".png",".webp",".heic",".heif"]);
export async function discoverPhotos(root:string):Promise<string[]> { const entries=await readdir(root,{withFileTypes:true}); const nested=await Promise.all(entries.map((entry)=>entry.isDirectory()?discoverPhotos(join(root,entry.name)):extensions.has(extname(entry.name).toLowerCase())?[join(root,entry.name)]:[])); return nested.flat().sort(); }
async function hashFile(path:string){return createHash("sha256").update(await readFile(path)).digest("hex");}

async function decodablePath(source:string,cache:string,hash:string){
  try{await sharp(source).rotate().resize(2,2,{fit:"inside"}).toBuffer();return source;}catch(error){
    if(process.platform!=="darwin"||![".heic",".heif"].includes(extname(source).toLowerCase())) throw error;
    const fallback=join(cache,`${hash}-heic-fallback.jpg`); await execute("sips",["-s","format","jpeg",source,"--out",fallback]); return fallback;
  }
}

export async function ingestPhotos(paths:string[],cacheDir:string,onProgress?:(message:string)=>void,force=false):Promise<PhotoRecord[]>{
  await mkdir(cacheDir,{recursive:true}); const limit=pLimit(4);
  const results=await Promise.all(paths.map((source,index)=>limit(async()=>{
    try{
      const hash=await hashFile(source),id=`u-${hash.slice(0,12)}`,cacheRecord=join(cacheDir,`${hash}-photo-v1.json`);
      if(!force){const cached=await readFile(cacheRecord,"utf8").then((value)=>JSON.parse(value) as PhotoRecord).catch(()=>undefined);if(cached){onProgress?.(`Cache hit ${index+1}/${paths.length}: ${basename(source)}`);return {...cached,sourcePath:source};}}
      const working=await decodablePath(source,cacheDir,hash);
      const metadata=await sharp(working).metadata(); if(!metadata.width||!metadata.height) throw new Error("Image dimensions are unavailable");
      const analysisPath=join(cacheDir,`${hash}-analysis.jpg`); await sharp(working).rotate().resize(512,512,{fit:"inside",withoutEnlargement:true}).flatten({background:"#111"}).jpeg({quality:78}).toFile(analysisPath);
      const exif=await exifr.parse(source,{gps:true,tiff:true,exif:true}).catch(()=>undefined) as Record<string,unknown>|undefined;
      const lat=typeof exif?.latitude==="number"?exif.latitude:undefined,lon=typeof exif?.longitude==="number"?exif.longitude:undefined;
      const capture=exif?.DateTimeOriginal instanceof Date?exif.DateTimeOriginal.toISOString():undefined;
      const record:PhotoRecord={id,hash,sourcePath:source,workingPath:working,analysisPath,width:metadata.width,height:metadata.height,captureTime:capture,camera:typeof exif?.Model==="string"?exif.Model:undefined,gps:lat!==undefined&&lon!==undefined?{lat,lon}:undefined,technical:await technicalScores(working,metadata.width,metadata.height),perceptualHash:await perceptualHash(working),rejectionReasons:[]};
      if(metadata.width*metadata.height<640*480)record.rejectionReasons.push("Resolution below 640×480"); if(record.technical.exposure<12)record.rejectionReasons.push("Nearly empty or severely exposed frame");
      await writeFile(cacheRecord,JSON.stringify(record));onProgress?.(`Ingested ${index+1}/${paths.length}: ${basename(source)}`); return record;
    }catch(error){onProgress?.(`Skipped ${basename(source)}: ${error instanceof Error?error.message:"Unreadable file"}`);return undefined;}
  })));
  return results.filter((result):result is PhotoRecord=>result!==undefined);
}
