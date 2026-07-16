import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runTrip } from "@/lib/pipeline/run";
import { validateStaticExport } from "@/lib/publishing/privacy";
import type { StudioJob, StudioJobRequest, StudioJobResult, StudioSelection, StudioStatus } from "@/lib/studio/types";

const execute=promisify(execFile),requestSchema=z.object({input:z.string().min(1),title:z.string().trim().max(120).optional(),people:z.enum(["include","exclude"]),maxPhotos:z.number().int().min(12).max(60),privacy:z.enum(["approximate","exact"])});
export type StudioRunner=(request:StudioJobRequest,onProgress:(stage:string,progress:number,message:string)=>void)=>Promise<StudioJobResult>;

export function createStudioServer({root=process.cwd(),port=4317,runner}:{root?:string;port?:number;runner?:StudioRunner}={}){
  const projectRoot=resolve(root),jobs=new Map<string,StudioJob>();let boundPort=port;
  const productionRunner=runner??((request,onProgress)=>runProductionJob(projectRoot,request,onProgress));
  const server=createServer((request,response)=>void route(request,response));

  async function route(request:IncomingMessage,response:ServerResponse){
    secure(response);const url=new URL(request.url??"/",`http://127.0.0.1:${boundPort}`);
    if(!trustedRequest(request,boundPort)){json(response,403,{error:"Wanderpage Studio only accepts requests from its local interface."});return;}
    if(request.method==="GET"&&url.pathname==="/api/status"){
      const active=[...jobs.values()].find((job)=>["queued","running","building"].includes(job.status));
      const status:StudioStatus={ready:true,openaiConfigured:Boolean(process.env.OPENAI_API_KEY),platform:process.platform,activeJobId:active?.id};json(response,200,status);return;
    }
    if(request.method==="POST"&&url.pathname==="/api/folders/pick"){try{json(response,200,{path:await chooseFolder()});}catch(error){json(response,400,{error:error instanceof Error?error.message:"Folder selection was cancelled."});}return;}
    if(request.method==="POST"&&url.pathname==="/api/jobs"){
      if([...jobs.values()].some((job)=>["queued","running","building"].includes(job.status))){json(response,409,{error:"A Wanderpage story is already being generated."});return;}
      try{const parsed=requestSchema.parse(await readJson(request));if(!isAbsolute(parsed.input))throw new Error("Choose an absolute photo-folder path.");const metadata=await stat(parsed.input);if(!metadata.isDirectory())throw new Error("The selected path is not a folder.");const job=createJob(parsed);jobs.set(job.id,job);json(response,202,{id:job.id});void executeJob(job,productionRunner);trimJobs(jobs);return;}catch(error){json(response,400,{error:message(error)});return;}
    }
    const match=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/);if(request.method==="GET"&&match){const job=jobs.get(match[1]!);if(!job){json(response,404,{error:"Job not found."});return;}json(response,200,job);return;}
    if(request.method==="GET"&&url.pathname==="/report"){await serveFile(join(projectRoot,".trip-output/report/index.html"),response);return;}
    if(request.method==="GET"||request.method==="HEAD"){await serveStatic(projectRoot,url.pathname,response,request.method==="HEAD");return;}
    json(response,404,{error:"Not found."});
  }

  async function executeJob(job:StudioJob,jobRunner:StudioRunner){
    update(job,"running",2,"Starting the local photo pipeline");
    try{job.result=await jobRunner(job.request,(stage,progress,message)=>update(job,stage==="build"?"building":"running",progress,message,stage));update(job,"complete",100,"Your trip page is ready");}
    catch(error){job.error=message(error);update(job,"failed",job.progress.progress,job.error);}
  }

  return {
    async start(){await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",()=>done());});const address=server.address();if(!address||typeof address==="string")throw new Error("Wanderpage Studio could not bind a local port");boundPort=address.port;return `http://127.0.0.1:${boundPort}/studio`;},
    async stop(){await new Promise<void>((done,reject)=>server.close((error)=>error?reject(error):done()));},
    open(){openBrowser(`http://127.0.0.1:${boundPort}/studio`);},
  };
}

async function runProductionJob(root:string,request:StudioJobRequest,onProgress:(stage:string,progress:number,message:string)=>void):Promise<StudioJobResult>{
  const result=await runTrip({...request,force:false,dryRun:false,demo:false},{root,onProgress:(event)=>onProgress(event.stage,Math.min(88,event.progress*.88),event.message)});
  onProgress("build",91,"Building the private static website");await execute(process.platform==="win32"?"pnpm.cmd":"pnpm",["build"],{cwd:root,maxBuffer:10_000_000});
  onProgress("privacy",97,"Checking metadata, paths, and secrets");const privacy=await validateStaticExport(join(root,"out"),[process.env.OPENAI_API_KEY??"",process.env.VERCEL_TOKEN??""]);if(privacy.errors.length)throw new Error(`Privacy validation failed: ${privacy.errors[0]}`);
  const selection=JSON.parse(await readFile(join(root,".trip-output/selection.json"),"utf8")) as StudioSelection;return {path:result.path,summary:result.summary,manifest:result.manifest,selection};
}

function createJob(request:StudioJobRequest):StudioJob{const now=new Date().toISOString();return {id:randomUUID(),status:"queued",createdAt:now,updatedAt:now,request,progress:{stage:"queued",progress:0,message:"Waiting to begin",at:now}};}
function update(job:StudioJob,status:StudioJob["status"],progress:number,messageText:string,stage:string=status){const now=new Date().toISOString();job.status=status;job.updatedAt=now;job.progress={stage,progress:Math.round(progress),message:messageText,at:now};}
function trimJobs(jobs:Map<string,StudioJob>){while(jobs.size>5){const oldest=[...jobs.keys()][0];if(oldest)jobs.delete(oldest);else break;}}
function message(error:unknown){if(error instanceof z.ZodError)return error.issues[0]?.message??"Invalid request.";return error instanceof Error?error.message:String(error);}

async function readJson(request:IncomingMessage){let body="";for await(const chunk of request){body+=String(chunk);if(body.length>65_536)throw new Error("Request is too large.");}return JSON.parse(body||"{}");}
function trustedRequest(request:IncomingMessage,port:number){const host=request.headers.host??"";if(!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host))return false;const origin=request.headers.origin;if(!origin)return true;return origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`;}
function secure(response:ServerResponse){response.setHeader("X-Content-Type-Options","nosniff");response.setHeader("Referrer-Policy","no-referrer");response.setHeader("Cross-Origin-Resource-Policy","same-origin");response.setHeader("Cache-Control","no-store");}
function json(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify(value));}

async function serveStatic(root:string,pathname:string,response:ServerResponse,head:boolean){const output=normalize(join(root,"out")),clean=decodeURIComponent(pathname).replace(/^\/+|\/+$/g,"")||"index.html",file=normalize(join(output,extname(clean)?clean:`${clean}.html`));if(!file.startsWith(`${output}/`)){response.writeHead(403).end();return;}await serveFile(file,response,head);}
async function serveFile(file:string,response:ServerResponse,head=false){try{const metadata=await stat(file);if(!metadata.isFile())throw new Error("Not a file");response.writeHead(200,{"Content-Type":mime(file),"Content-Length":metadata.size});if(head)response.end();else createReadStream(file).pipe(response);}catch{response.writeHead(404).end("Not found");}}
function mime(path:string){return ({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".webp":"image/webp",".png":"image/png",".jpg":"image/jpeg",".txt":"text/plain; charset=utf-8"} as Record<string,string>)[extname(path).toLowerCase()]??"application/octet-stream";}

async function chooseFolder(){
  if(process.platform==="darwin"){const {stdout}=await execute("osascript",["-e",'POSIX path of (choose folder with prompt "Choose the folder containing your trip photos")']);return stdout.trim().replace(/\/$/,"");}
  if(process.platform==="linux"){const {stdout}=await execute("zenity",["--file-selection","--directory","--title=Choose your trip photo folder"]);return stdout.trim();}
  throw new Error("The native folder picker is unavailable here. Paste the absolute folder path instead.");
}
function openBrowser(url:string){const command=process.platform==="darwin"?"open":process.platform==="win32"?"cmd":"xdg-open",args=process.platform==="win32"?["/c","start","",url]:[url];const child=spawn(command,args,{detached:true,stdio:"ignore"});child.unref();}
