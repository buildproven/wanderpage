import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DestinationEvidence } from "@/lib/location/infer";
import type { PhotoRecord } from "@/lib/photos/types";
import type { SelectionResult } from "@/lib/selection/select";

export async function writeReports(output:string,photos:PhotoRecord[],selection:SelectionResult,destinations:DestinationEvidence[],summary:Record<string,unknown>){
  await mkdir(join(output,"report"),{recursive:true});await Promise.all([
    writeFile(join(output,"photo-analysis.json"),JSON.stringify(photos.map(safePhoto),null,2)),
    writeFile(join(output,"location-analysis.json"),JSON.stringify(destinations,null,2)),
    writeFile(join(output,"selection.json"),JSON.stringify({selected:selection.selected.map((p)=>p.id),rejected:selection.rejected.map((p)=>({id:p.id,reason:selection.reasons[p.id]})),reasons:selection.reasons},null,2)),
    writeFile(join(output,"run-summary.json"),JSON.stringify(summary,null,2)),
    writeFile(join(output,"report/index.html"),reportHtml(photos,selection,destinations,summary)),
  ]);
}
function safePhoto(photo:PhotoRecord){return {id:photo.id,hash:photo.hash,width:photo.width,height:photo.height,captureTime:photo.captureTime,camera:photo.camera,technical:photo.technical,perceptualHash:photo.perceptualHash,duplicateOf:photo.duplicateOf,similarityCluster:photo.similarityCluster,semantic:photo.semantic,rejectionReasons:photo.rejectionReasons,gpsPresent:photo.gps!==undefined};}
function reportHtml(photos:PhotoRecord[],selection:SelectionResult,destinations:DestinationEvidence[],summary:Record<string,unknown>){const rows=photos.map((p)=>`<tr><td>${p.id}</td><td>${selection.selected.includes(p)?"Selected":"Rejected"}</td><td>${p.technical.overall.toFixed(1)}</td><td>${escape(selection.reasons[p.id]??"")}</td></tr>`).join("");return `<!doctype html><html><head><meta charset="utf-8"><title>Wanderpage run report</title><style>body{font:15px system-ui;max-width:1100px;margin:3rem auto;padding:0 1rem;color:#17211f}table{border-collapse:collapse;width:100%}td,th{padding:.7rem;border-bottom:1px solid #ddd;text-align:left}code{background:#eee;padding:.2rem}</style></head><body><h1>Wanderpage run report</h1><p>Local-only processing report. ${photos.length} readable photos; ${selection.selected.length} selected; ${destinations.length} destination clusters.</p><h2>Photos</h2><table><thead><tr><th>ID</th><th>Decision</th><th>Technical</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table><h2>Destination evidence</h2>${destinations.map((d)=>`<h3>${escape(d.name)} (${d.confidence.toFixed(2)})</h3><ul>${d.evidence.map((e)=>`<li>${escape(e)}</li>`).join("")}</ul>`).join("")}<h2>Run summary</h2><pre>${escape(JSON.stringify(summary,null,2))}</pre></body></html>`;}
function escape(value:string){return value.replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));}
