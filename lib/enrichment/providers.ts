import type { DestinationEvidence } from "@/lib/location/infer";

export type Enrichment={introduction:string;facts:Array<{text:string;sourceId:string}>;sources:Array<{id:string;title:string;url:string;provider:string;author?:string;license?:string}>;weather?:string};
export async function enrichDestination(destination:DestinationEvidence,userAgent:string,date?:string):Promise<Enrichment>{
  if(destination.confidence<.55)return {introduction:"This part of the route remains intentionally unlabeled because the available location evidence is limited.",facts:[],sources:[]};
  const safeName=destination.confidence>=.8?destination.name:"the surrounding region";const sourceId=`wikipedia-${destination.id}`;
  try{
    const summaryUrl=`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(destination.name)}`;const response=await fetch(summaryUrl,{headers:{"User-Agent":userAgent}});if(!response.ok)throw new Error(`Wikipedia summary ${response.status}`);const data=await response.json() as {extract?:string;content_urls?:{desktop?:{page?:string}}};const sentences=(data.extract??"").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,3);
    const weather=date?await historicalWeather(destination.lat,destination.lon,date).catch(()=>undefined):undefined;
    return {introduction:sentences[0]??`Photographs place this chapter around ${safeName}.`,facts:sentences.slice(1,3).map((text)=>({text,sourceId})),sources:[{id:sourceId,title:destination.name,url:data.content_urls?.desktop?.page??`https://en.wikipedia.org/wiki/${encodeURIComponent(destination.name)}`,provider:"Wikipedia / Wikimedia Foundation"}],weather};
  }catch{return {introduction:`Available metadata supports the broader area around ${safeName}; external context was unavailable during this run.`,facts:[],sources:[]};}
}
async function historicalWeather(lat:number,lon:number,date:string){const url=new URL("https://archive-api.open-meteo.com/v1/archive");url.search=new URLSearchParams({latitude:String(lat),longitude:String(lon),start_date:date,end_date:date,daily:"temperature_2m_max,temperature_2m_min,precipitation_sum",timezone:"auto"}).toString();const response=await fetch(url);if(!response.ok)throw new Error("Weather unavailable");const data=await response.json() as {daily?:{temperature_2m_max?:number[];temperature_2m_min?:number[];precipitation_sum?:number[]}};const hi=data.daily?.temperature_2m_max?.[0],lo=data.daily?.temperature_2m_min?.[0];return hi!==undefined&&lo!==undefined?`${Math.round(lo)}–${Math.round(hi)} °C`:undefined;}
