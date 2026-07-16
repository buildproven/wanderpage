import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";

const forbidden=[/\/Users\//,/\\Users\\/i,/\.trip-output/i,/\.trip-cache/i,/OPENAI_API_KEY\s*=/i,/VERCEL_TOKEN\s*=/i];

async function walk(path:string):Promise<string[]>{
  const entries=await readdir(path,{withFileTypes:true});
  return (await Promise.all(entries.map((entry)=>entry.isDirectory()?walk(join(path,entry.name)):[join(path,entry.name)]))).flat();
}

export async function validateStaticExport(outputPath:string,secrets:string[]=[]){
  const root=resolve(outputPath),files=await walk(root),errors:string[]=[];
  for(const file of files){
    const extension=extname(file).toLowerCase();
    if([".webp",".jpg",".jpeg",".png",".avif"].includes(extension)){
      const metadata=await sharp(file).metadata();
      if(metadata.exif||metadata.xmp||metadata.iptc)errors.push(`${file}: embedded metadata`);
    }else if([".html",".js",".json",".txt",".css",".xml"].includes(extension)){
      const value=await readFile(file,"utf8");
      for(const pattern of forbidden)if(pattern.test(value))errors.push(`${file}: matched ${pattern}`);
      for(const secret of secrets.filter((item)=>item.length>8))if(value.includes(secret))errors.push(`${file}: contains a configured secret`);
    }
  }
  return {files,errors};
}
