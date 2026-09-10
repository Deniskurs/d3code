// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone artifact tooling uses Node file APIs without a server runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const variants = ["dev", "nightly", "prod"] as const;
const background = "#fff7e5";
const source = await NodeFSP.readFile(`${root}assets/devis/source.png`);
const metadata = await sharp(source).metadata();
if (!metadata.width || metadata.width !== metadata.height)
  throw new Error("The Devis source artwork must be square.");

async function output(path: string, data: string | Buffer) {
  const destination = `${root}${path}`;
  const bytes = Buffer.from(data);
  if (check) {
    const existing = await NodeFSP.readFile(destination);
    const matches = path.endsWith(".json")
      ? JSON.stringify(JSON.parse(existing.toString("utf8"))) ===
        JSON.stringify(JSON.parse(bytes.toString("utf8")))
      : existing.equals(bytes);
    if (!matches) throw new Error(`Icon is stale: ${path}`);
  } else {
    await NodeFSP.mkdir(destination.substring(0, destination.lastIndexOf("/")), {
      recursive: true,
    });
    await NodeFSP.writeFile(destination, bytes);
  }
}
const resize = (input: Buffer, size: number) => sharp(input).resize(size, size).png().toBuffer();
const roundedMask = (size: number, radius: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="white"/></svg>`,
  );
const icon = await resize(source, 1024);
const framed = await sharp(icon)
  .resize(824, 824)
  .composite([{ input: roundedMask(824, 190), blend: "dest-in" }])
  .png()
  .toBuffer();
const macIcon = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
})
  .composite([{ input: framed, left: 100, top: 100 }])
  .png()
  .toBuffer();

// Android and widget template icons need an alpha silhouette. Derive it from
// this artwork's blue ink, keeping its original outline and texture.
const { data, info } = await sharp(icon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const monochrome = Buffer.from(data);
for (let offset = 0; offset < data.length; offset += 4) {
  const alpha = Math.round(
    Math.max(0, Math.min(1, (data[offset + 2]! - data[offset]!) / 64)) * 255,
  );
  data[offset + 3] = alpha;
  monochrome[offset] = monochrome[offset + 1] = monochrome[offset + 2] = 255;
  monochrome[offset + 3] = alpha;
}
const mark = await sharp(data, { raw: info }).png().toBuffer();
const template = await sharp(monochrome, { raw: info }).png().toBuffer();
const safeZone = async (input: Buffer) =>
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00000000" } })
    .composite([{ input: await resize(input, 640), left: 192, top: 192 }])
    .png()
    .toBuffer();
const adaptiveMark = await safeZone(mark);
const adaptiveTemplate = await safeZone(template);
const backgroundPng = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background },
})
  .png()
  .toBuffer();
const splash = await sharp(backgroundPng)
  .composite([{ input: adaptiveMark }])
  .png()
  .toBuffer();
const ico = encodePngIco(
  await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await resize(icon, size) })),
  ),
);

for (const variant of variants) {
  const dir = `assets/devis/${variant}`;
  await output(`${dir}/icon.png`, icon);
  await output(`${dir}/mac-icon.png`, macIcon);
  await output(`${dir}/icon.ico`, ico);
  for (const [filename, size] of [
    ["apple-touch.png", 180],
    ["favicon-16.png", 16],
    ["favicon-32.png", 32],
  ] as const)
    await output(`${dir}/${filename}`, await resize(icon, size));
  await output(`${dir}/background.png`, backgroundPng);
  await output(`${dir}/splash.png`, splash);
  await output(`${dir}/app-icon.icon/Assets/mark.png`, mark);
  await output(
    `${dir}/app-icon.icon/icon.json`,
    JSON.stringify(
      {
        fill: { solid: "srgb:1.00000,0.96863,0.89804,1.00000" },
        groups: [
          {
            layers: [
              {
                "image-name": "mark.png",
                name: "Devis",
                position: { scale: 1, "translation-in-points": [0, 0] },
              },
            ],
          },
        ],
        "supported-platforms": { squares: "shared" },
      },
      null,
      2,
    ) + "\n",
  );
}
await output("assets/devis/brand.png", await resize(icon, 128));
await output("assets/devis/mark.png", adaptiveMark);
await output("assets/devis/monochrome.png", adaptiveTemplate);
await output("assets/devis/notification.png", await resize(template, 96));
await output("apps/mobile/assets/widget/T3Mark.png", await resize(template, 256));
for (const directory of ["apps/web/public", "apps/marketing/public"]) {
  await output(`${directory}/favicon.ico`, ico);
  await output(`${directory}/favicon-16x16.png`, await resize(icon, 16));
  await output(`${directory}/favicon-32x32.png`, await resize(icon, 32));
  await output(`${directory}/apple-touch-icon.png`, await resize(icon, 180));
}
for (const name of ["icon.webp", "icon-nightly.webp"])
  await output(
    `apps/marketing/src/assets/${name}`,
    await sharp(icon).resize(256).webp({ quality: 90 }).toBuffer(),
  );
console.log(check ? "Devis artwork exports verified." : "Devis artwork exported.");
