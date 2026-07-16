#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createStudioServer } from "@/lib/studio/server";

const execute=promisify(execFile),root=process.cwd(),port=Number(process.env.WANDERPAGE_PORT??4317);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error("WANDERPAGE_PORT must be a valid port number.");
if(!process.argv.includes("--no-build")||!await stat(join(root,"out/studio.html")).then(()=>true).catch(()=>false)){
  console.log("Preparing Wanderpage Studio…");await execute(process.platform==="win32"?"pnpm.cmd":"pnpm",["build"],{cwd:root,maxBuffer:10_000_000});
}
const studio=createStudioServer({root,port}),url=await studio.start();console.log(`Wanderpage Studio is ready at ${url}`);if(!process.argv.includes("--no-open"))studio.open();
const shutdown=async()=>{await studio.stop();process.exitCode=0;};process.once("SIGINT",()=>void shutdown());process.once("SIGTERM",()=>void shutdown());
