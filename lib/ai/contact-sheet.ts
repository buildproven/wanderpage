import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { PhotoRecord } from "@/lib/photos/types";

export async function buildContactSheet(photos: PhotoRecord[], output: string) {
  await mkdir(dirname(output), { recursive: true });
  const tileW = 300,
    tileH = 250;
  const canvas = sharp({ create: { width: tileW * 4, height: tileH * 4, channels: 3, background: "#f4f0e8" } });
  const composite: OverlayOptions[] = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]!,
      x = (i % 4) * tileW,
      y = Math.floor(i / 4) * tileH;
    const image = await sharp(photo.analysisPath)
      .resize(tileW - 16, tileH - 46, { fit: "contain", background: "#111" })
      .jpeg()
      .toBuffer();
    const label = Buffer.from(
      `<svg width="${tileW}" height="34"><rect width="100%" height="100%" fill="#f4f0e8"/><text x="12" y="23" font-family="monospace" font-weight="700" font-size="17" fill="#17211f">${photo.id}</text></svg>`
    );
    composite.push({ input: image, left: x + 8, top: y + 6 }, { input: label, left: x, top: y + tileH - 34 });
  }
  await canvas.composite(composite).jpeg({ quality: 82 }).toFile(output);
  return output;
}
