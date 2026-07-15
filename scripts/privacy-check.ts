import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";

const root=resolve("out");const secretValues=[process.env.OPENAI_API_KEY,process.env.VERCEL_TOKEN].filter((value):value is string=>Boolean(value&&value.length>8));const forbidden=[/\/Users\//,/\\Users\\/i,/\.trip-output/i,/\.trip-cache/i,/OPENAI_API_KEY\s*=/i,/VERCEL_TOKEN\s*=/i];
async function walk(path:string):Promise<string[]>{const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.map((entry)=>entry.isDirectory()?walk(join(path,entry.name)):[join(path,entry.name)]))).flat();}
const files=await walk(root),errors:string[]=[];for(const file of files){const extension=extname(file).toLowerCase();if([".webp",".jpg",".jpeg",".png",".avif"].includes(extension)){const meta=await sharp(file).metadata();if(meta.exif||meta.xmp||meta.iptc)errors.push(`${file}: embedded metadata`);}else if([".html",".js",".json",".txt",".css",".xml"].includes(extension)){const value=await readFile(file,"utf8");for(const pattern of forbidden)if(pattern.test(value))errors.push(`${file}: matched ${pattern}`);for(const secret of secretValues)if(value.includes(secret))errors.push(`${file}: contains a configured secret`);}}
if(errors.length){console.error(errors.join("\n"));process.exitCode=1;}else console.log(`Privacy validation passed: ${files.length} exported files, no metadata, local paths, reports, or secrets.`);
