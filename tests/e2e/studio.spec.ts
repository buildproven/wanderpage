import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { TripManifest } from "../../lib/schemas/trip";

const manifest=JSON.parse(readFileSync(new URL("../../data/trip.demo.json",import.meta.url),"utf8")) as TripManifest;

test("creates a story through the local Studio interface",async({page,context})=>{
  let jobReads=0;
  await page.route("**/api/**",async(route)=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==="/api/status")return route.fulfill({json:{ready:true,openaiConfigured:true,platform:"darwin"}});
    if(path==="/api/folders/pick")return route.fulfill({json:{path:"/Users/test/Pictures/Oregon"}});
    if(path==="/api/jobs"&&request.method()==="POST")return route.fulfill({status:202,json:{id:"fixture-job"}});
    if(path==="/api/jobs/fixture-job"){
      jobReads++;
      if(jobReads<2)return route.fulfill({json:{id:"fixture-job",status:"running",createdAt:"2026-07-15T12:00:00Z",updatedAt:"2026-07-15T12:00:01Z",request:{input:"/Users/test/Pictures/Oregon",people:"exclude",maxPhotos:36,privacy:"approximate"},progress:{stage:"analyze",progress:56,message:"Analyzing contact sheet 1 of 1",at:"2026-07-15T12:00:01Z"}}});
      return route.fulfill({json:{id:"fixture-job",status:"complete",createdAt:"2026-07-15T12:00:00Z",updatedAt:"2026-07-15T12:00:03Z",request:{input:"/Users/test/Pictures/Oregon",people:"exclude",maxPhotos:36,privacy:"approximate"},progress:{stage:"complete",progress:100,message:"Your Wanderpage story is ready",at:"2026-07-15T12:00:03Z"},result:{manifest,summary:{inputPhotos:8,selectedPhotos:8,duplicatesRemoved:0},selection:{selected:manifest.photos.map((photo)=>photo.id),rejected:[],reasons:{}}}}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });

  await page.goto("/studio");
  await expect(page.getByText("Local engine ready")).toBeVisible();
  await page.getByRole("button",{name:"Choose folder"}).click();
  await expect(page.getByLabel("Photo folder path")).toHaveValue("/Users/test/Pictures/Oregon");
  await page.getByLabel(/Story title/).fill("Oregon, held in light");
  await page.getByRole("button",{name:/Build my Wanderpage/}).click();
  await expect(page.getByRole("heading",{name:/Analyzing contact sheet/})).toBeVisible();
  await expect(page.getByText("The edit is ready")).toBeVisible();
  await expect(page.getByRole("heading",{name:"A Line Along the Pacific"})).toBeVisible();
  const popupPromise=context.waitForEvent("page");await page.getByRole("link",{name:/Open the story/}).click();const story=await popupPromise;await story.waitForLoadState();expect(story.url()).toMatch(/\/demo/);
});
