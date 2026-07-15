import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { PhotoRecord } from "@/lib/photos/types";

export type PublishedPhoto={id:string;srcLarge:string;srcMedium:string;srcThumb:string;width:number;height:number;blurDataURL:string};
export async function publishPhoto(photo:PhotoRecord,publicDir:string):Promise<PublishedPhoto>{
  await mkdir(publicDir,{recursive:true});const base=photo.id.replace(/[^a-z0-9-]/gi,"");const large=join(publicDir,`${base}-large.webp`),medium=join(publicDir,`${base}-medium.webp`),thumb=join(publicDir,`${base}-thumb.webp`);
  const source=sharp(photo.workingPath).rotate();await source.clone().resize(1800,1800,{fit:"inside",withoutEnlargement:true}).webp({quality:80}).toFile(large);await source.clone().resize(900,900,{fit:"inside",withoutEnlargement:true}).webp({quality:78}).toFile(medium);await source.clone().resize(420,420,{fit:"inside",withoutEnlargement:true}).webp({quality:76}).toFile(thumb);
  const metadata=await sharp(large).metadata();const blur=(await source.clone().resize(24,24,{fit:"inside"}).webp({quality:35}).toBuffer()).toString("base64");return {id:photo.id,srcLarge:`/trip/generated/${base}-large.webp`,srcMedium:`/trip/generated/${base}-medium.webp`,srcThumb:`/trip/generated/${base}-thumb.webp`,width:metadata.width??photo.width,height:metadata.height??photo.height,blurDataURL:`data:image/webp;base64,${blur}`};
}
export async function outputBytes(paths:string[]){let total=0;for(const path of paths)total+=(await stat(path)).size;return total;}
