import { spawn } from "node:child_process";

export async function deploy(){await new Promise<void>((resolve,reject)=>{const args=["deploy","out","-y"];if(process.env.VERCEL_TOKEN)args.push("--token",process.env.VERCEL_TOKEN);const child=spawn("vercel",args,{stdio:"inherit"});child.on("error",reject);child.on("exit",(code)=>code===0?resolve():reject(new Error(`Vercel exited with code ${code}`)));});}
if(import.meta.url===new URL(process.argv[1]??"",`file://${process.cwd()}/`).href)await deploy();
