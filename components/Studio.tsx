"use client";

import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { StudioJob, StudioStatus } from "@/lib/studio/types";

type Connection="checking"|"ready"|"offline";

export default function Studio(){
  const [connection,setConnection]=useState<Connection>("checking"),[status,setStatus]=useState<StudioStatus>();
  const [folder,setFolder]=useState(""),[title,setTitle]=useState(""),[people,setPeople]=useState<"include"|"exclude">("include"),[privacy,setPrivacy]=useState<"approximate"|"exact">("approximate"),[maxPhotos,setMaxPhotos]=useState(36);
  const [job,setJob]=useState<StudioJob>(),[error,setError]=useState(""),[picking,setPicking]=useState(false);

  useEffect(()=>{void api<StudioStatus>("/api/status").then((value)=>{setStatus(value);setPeople(value.openaiConfigured?"exclude":"include");setConnection("ready");}).catch(()=>setConnection("offline"));},[]);
  useEffect(()=>{if(!job||["complete","failed"].includes(job.status))return;const timer=window.setInterval(()=>void api<StudioJob>(`/api/jobs/${job.id}`).then(setJob).catch((reason)=>setError(reason instanceof Error?reason.message:"Unable to read job status.")),650);return()=>window.clearInterval(timer);},[job]);
  const busy=job&&!["complete","failed"].includes(job.status),selected=job?.result?.manifest.photos??[],rejected=job?.result?.selection.rejected.length??0;
  const phase=job?.status==="complete"?"complete":busy?"working":"setup";
  const displayedError=job?.status==="failed"?job.error??"Story generation failed.":error;
  const canBuild=connection==="ready"&&folder.trim().length>0&&!busy&&!(people==="exclude"&&!status?.openaiConfigured);

  async function chooseFolder(){setError("");setPicking(true);try{const value=await api<{path:string}>("/api/folders/pick",{method:"POST"});setFolder(value.path);}catch(reason){setError(reason instanceof Error?reason.message:"Folder selection was cancelled.");}finally{setPicking(false);}}
  async function submit(event:FormEvent){event.preventDefault();if(!canBuild)return;setError("");setJob(undefined);try{const value=await api<{id:string}>("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:folder.trim(),title:title.trim()||undefined,people,maxPhotos,privacy})});setJob(await api<StudioJob>(`/api/jobs/${value.id}`));}catch(reason){setError(reason instanceof Error?reason.message:"Could not start Wanderpage.");}}

  return <main className="studio-page">
    <aside className="studio-atmosphere" aria-hidden="true"><Image src="/trip/demo/coast-hero-large.webp" alt="" fill priority sizes="38vw"/><div className="studio-atmosphere-copy"><span>Wanderpage Studio</span><p>Your originals stay here.<br/>Only the edit travels.</p></div></aside>
    <section className="studio-workspace">
      <header className="studio-header"><Link href="/" className="studio-wordmark">Wanderpage</Link><div className={`studio-connection ${connection}`}><i/>{connection==="ready"?"Local engine ready":connection==="checking"?"Finding local engine":"Start with pnpm studio"}</div></header>
      <div className="studio-body">
        <nav className="studio-phases" aria-label="Creation progress"><Phase index="01" label="Set up" active={phase==="setup"} done={phase!=="setup"}/><Phase index="02" label="Edit" active={phase==="working"} done={phase==="complete"}/><Phase index="03" label="Review" active={phase==="complete"} done={false}/></nav>
        <AnimatePresence mode="wait">
          {phase==="setup"&&<motion.div className="studio-panel" key="setup" initial={{opacity:0,y:18}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-12}}>
            <div className="studio-title"><span className="eyebrow">New story</span><h1>Choose the trip<br/><em>worth keeping.</em></h1><p>Wanderpage will score, edit, and arrange the strongest frames. It may leave photos out.</p></div>
            <form className="studio-form" onSubmit={submit}>
              <label className="studio-field studio-folder"><span>Photo folder</span><div><input value={folder} onChange={(event)=>setFolder(event.target.value)} placeholder="Choose a folder or paste its absolute path" required aria-label="Photo folder path"/><button type="button" onClick={()=>void chooseFolder()} disabled={connection!=="ready"||picking}>{picking?"Choosing…":"Choose folder"}</button></div></label>
              <label className="studio-field"><span>Story title <small>Optional</small></span><input value={title} onChange={(event)=>setTitle(event.target.value)} placeholder="Late September in Portugal" maxLength={120}/></label>
              <fieldset className="studio-field studio-choice"><legend>People in the published story</legend><div><Choice label="Include" detail="People may appear; nobody is identified." checked={people==="include"} onChange={()=>setPeople("include")}/><Choice label="Exclude" detail={status?.openaiConfigured?"Remove every frame with a visible person.":"Requires an OpenAI API key."} checked={people==="exclude"} disabled={!status?.openaiConfigured} onChange={()=>setPeople("exclude")}/></div></fieldset>
              <fieldset className="studio-field studio-choice"><legend>Map precision</legend><div><Choice label="Approximate" detail="Recommended. Broader public route." checked={privacy==="approximate"} onChange={()=>setPrivacy("approximate")}/><Choice label="Closer" detail="Still rounded; never exact GPS." checked={privacy==="exact"} onChange={()=>setPrivacy("exact")}/></div></fieldset>
              <label className="studio-field studio-range"><span>Maximum edit <strong>{maxPhotos} photos</strong></span><input type="range" min="12" max="60" step="4" value={maxPhotos} onChange={(event)=>setMaxPhotos(Number(event.target.value))}/><small>Wanderpage can use fewer when the edit is stronger.</small></label>
              {displayedError&&<p className="studio-error" role="alert">{displayedError}</p>}
              <button className="studio-build" type="submit" disabled={!canBuild}><span>Build my Wanderpage</span><b>→</b></button>
            </form>
          </motion.div>}
          {phase==="working"&&job&&<motion.div className="studio-panel studio-working" key="working" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>
            <div className="studio-title"><span className="eyebrow">Editing locally</span><h1>{job.progress.message}</h1><p>You can leave this window open. Originals are read only and the website receives metadata-free copies.</p></div>
            <div className="studio-progress" aria-live="polite"><div className="studio-progress-number">{job.progress.progress}<span>%</span></div><div className="studio-progress-track"><motion.i animate={{width:`${job.progress.progress}%`}} transition={{ease:[.2,.7,.2,1],duration:.45}}/></div><div className="studio-progress-meta"><span>{job.progress.stage}</span><span>{folderName(folder)}</span></div></div>
          </motion.div>}
          {phase==="complete"&&job?.result&&<motion.div className="studio-panel studio-complete" key="complete" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}}>
            <div className="studio-title"><span className="eyebrow">The edit is ready</span><h1>{job.result.manifest.title}</h1><p>{selected.length} selected · {rejected} left out · {numberValue(job.result.summary,"duplicatesRemoved")} duplicates removed</p></div>
            <div className="studio-review-strip">{selected.slice(0,5).map((photo,index)=><motion.div key={photo.id} initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:index*.08}}><Image src={photo.srcThumb} alt={photo.alt} width={photo.width} height={photo.height}/></motion.div>)}</div>
            <div className="studio-result-actions"><a className="studio-build" href="/demo" target="_blank" rel="noreferrer"><span>Open the story</span><b>↗</b></a><a href="/report" target="_blank" rel="noreferrer">Review every decision</a><button type="button" onClick={()=>{setJob(undefined);setError("");}}>Make another</button></div>
          </motion.div>}
        </AnimatePresence>
        {phase!=="setup"&&displayedError&&<p className="studio-error" role="alert">{displayedError}</p>}
      </div>
      <footer className="studio-footer"><span>Local-first photo editing</span><span>No identity recognition · No exact GPS · Originals untouched</span></footer>
    </section>
  </main>;
}

function Phase({index,label,active,done}:{index:string;label:string;active:boolean;done:boolean}){return <div className={active?"active":done?"done":""}><span>{done?"✓":index}</span><b>{label}</b></div>;}
function Choice({label,detail,checked,disabled,onChange}:{label:string;detail:string;checked:boolean;disabled?:boolean;onChange:()=>void}){return <label className={disabled?"disabled":""}><input type="radio" checked={checked} disabled={disabled} onChange={onChange}/><span><b>{label}</b><small>{detail}</small></span></label>;}
function folderName(path:string){return path.split(/[\\/]/).filter(Boolean).at(-1)??"Photo folder";}
function numberValue(summary:Record<string,unknown>,key:string){const value=summary[key];return typeof value==="number"?value:0;}
async function api<T>(path:string,init?:RequestInit):Promise<T>{const response=await fetch(path,init);const value=await response.json() as T&{error?:string};if(!response.ok)throw new Error(value.error??`Request failed (${response.status})`);return value;}
