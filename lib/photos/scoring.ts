import sharp from "sharp";
import type { TechnicalScores } from "./types";

const clamp = (value:number) => Math.max(0, Math.min(100, value));
const mean = (values:number[]) => values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length);
const variance = (values:number[], center=mean(values)) => mean(values.map((value)=>(value-center)**2));

export async function technicalScores(path:string, width:number, height:number):Promise<TechnicalScores> {
  const { data, info } = await sharp(path).rotate().resize(128,128,{fit:"inside"}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const lum:number[]=[]; const saturation:number[]=[]; let clipped=0;
  for(let i=0;i<data.length;i+=info.channels){
    const r=data[i]??0,g=data[i+1]??0,b=data[i+2]??0; const y=.2126*r+.7152*g+.0722*b; lum.push(y);
    saturation.push(Math.max(r,g,b)-Math.min(r,g,b)); if(y<6||y>249) clipped++;
  }
  const average=mean(lum), contrast=clamp(Math.sqrt(variance(lum))*2.2), exposure=clamp(100-Math.abs(average-128)*.8);
  let edges=0, edgeCount=0;
  for(let y=1;y<info.height-1;y++) for(let x=1;x<info.width-1;x++){
    const idx=y*info.width+x; const lap=(lum[idx-info.width]??0)+(lum[idx+info.width]??0)+(lum[idx-1]??0)+(lum[idx+1]??0)-4*(lum[idx]??0);
    edges+=lap*lap; edgeCount++;
  }
  const sharpness=clamp(Math.sqrt(edges/Math.max(1,edgeCount))*.85); const resolution=clamp(Math.sqrt(width*height)/24);
  const clipping=clamp(100-(clipped/lum.length)*500); const colorBalance=clamp(55+mean(saturation)*.55);
  const noise=clamp(100-Math.max(0,sharpness-82)*1.8);
  const overall=clamp(sharpness*.25+exposure*.2+contrast*.15+colorBalance*.1+resolution*.15+noise*.05+clipping*.1);
  return {sharpness,exposure,contrast,colorBalance,resolution,noise,clipping,overall};
}

export async function perceptualHash(path:string):Promise<string>{
  const {data}=await sharp(path).rotate().grayscale().resize(9,8,{fit:"fill"}).raw().toBuffer({resolveWithObject:true});
  let bits=""; for(let y=0;y<8;y++) for(let x=0;x<8;x++) bits+=(data[y*9+x]??0)>(data[y*9+x+1]??0)?"1":"0";
  return BigInt(`0b${bits}`).toString(16).padStart(16,"0");
}

export function hammingDistance(a:string,b:string){ let value=BigInt(`0x${a}`)^BigInt(`0x${b}`),count=0; while(value){count+=Number(value&1n);value>>=1n;} return count; }
