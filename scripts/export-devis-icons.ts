// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone artifact tooling uses Node file APIs without a server runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

import sharp from "sharp";
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const variants = [
  { name: "dev", color: "#55dcca", background: "#102c32", label: "DEV" },
  { name: "nightly", color: "#b8a2ff", background: "#201a3b", label: "NIGHTLY" },
  { name: "prod", color: "#ffbd59", background: "#171b22", label: "" },
] as const;
const mark = (color: string) =>
  `<path d="M225 298H351C461 298 512 373 512 512S461 726 351 726H225V298ZM309 380V644H348C404 644 430 602 430 512S404 380 348 380H309Z" fill="${color}" fill-rule="evenodd"/><path d="M574 300H792V381L690 473C764 483 805 525 805 597C805 681 750 730 659 730C609 730 566 716 531 688L575 618C600 638 628 649 659 649C699 649 723 630 723 601C723 570 699 552 653 552H601V479L702 382H574V300Z" fill="${color === "white" ? "white" : "#f6f4ef"}"/>`;
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>\n`;
const png = (source: string, size: number) =>
  sharp(Buffer.from(source)).resize(size, size).png().toBuffer();
async function output(path: string, data: string | Buffer) {
  const destination = `${root}${path}`;
  const bytes = Buffer.from(data);
  if (check) {
    if (!(await NodeFSP.readFile(destination)).equals(bytes))
      throw new Error(`Icon is stale: ${path}`);
  } else {
    await NodeFSP.mkdir(destination.substring(0, destination.lastIndexOf("/")), {
      recursive: true,
    });
    await NodeFSP.writeFile(destination, bytes);
  }
}
for (const variant of variants) {
  const dir = `assets/devis/${variant.name}`;
  const badge = variant.label
    ? `<rect x="380" y="796" width="264" height="60" rx="30" fill="${variant.color}"/><text x="512" y="839" text-anchor="middle" font-family="Helvetica,sans-serif" font-size="38" font-weight="700" letter-spacing="4" fill="${variant.background}">${variant.label}</text>`
    : "";
  const body = `<rect x="100" y="100" width="824" height="824" rx="190" fill="${variant.background}"/>${mark(variant.color)}${badge}`;
  const source = svg(body);
  await output(`${dir}/icon.svg`, source);
  for (const [filename, size] of [
    ["icon.png", 1024],
    ["apple-touch.png", 180],
    ["favicon-16.png", 16],
    ["favicon-32.png", 32],
  ] as const) {
    await output(`${dir}/${filename}`, await png(source, size));
  }
  await output(
    `${dir}/icon.ico`,
    encodePngIco(
      await Promise.all(
        WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await png(source, size) })),
      ),
    ),
  );
  await output(
    `${dir}/background.png`,
    await png(svg(`<rect width="1024" height="1024" fill="${variant.background}"/>`), 1024),
  );
  await output(
    `${dir}/splash.png`,
    await png(
      svg(
        `<rect width="1024" height="1024" fill="${variant.background}"/><g transform="translate(154 154) scale(.7)">${mark(variant.color)}</g>`,
      ),
      1024,
    ),
  );
  await output(`${dir}/app-icon.icon/Assets/mark.svg`, svg(mark(variant.color)));
  await output(
    `${dir}/app-icon.icon/icon.json`,
    JSON.stringify(
      {
        fill: {
          solid:
            "display-p3:" +
            [1, 3, 5]
              .map((start) =>
                (parseInt(variant.background.slice(start, start + 2), 16) / 255).toFixed(5),
              )
              .join(",") +
            ",1.00000",
        },
        groups: [
          {
            layers: [
              {
                "image-name": "mark.svg",
                name: "D3",
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
  if (variant.name === "dev") {
    for (const [name, file] of [
      ["favicon.ico", "icon.ico"],
      ["favicon-16x16.png", "favicon-16.png"],
      ["favicon-32x32.png", "favicon-32.png"],
      ["apple-touch-icon.png", "apple-touch.png"],
    ]) {
      await output(`apps/web/public/${name}`, await NodeFSP.readFile(`${root}${dir}/${file}`));
    }
  }
}
await output(
  "assets/devis/mark.png",
  await png(svg(`<g transform="translate(154 154) scale(.7)">${mark("#ffbd59")}</g>`), 1024),
);
await output(
  "assets/devis/monochrome.png",
  await png(svg(`<g transform="translate(154 154) scale(.7)">${mark("white")}</g>`), 1024),
);
await output("assets/devis/notification.png", await png(svg(mark("white")), 96));
await output("apps/mobile/assets/widget/T3Mark.svg", svg(mark("white")));
console.log(check ? "D3 icon variants verified." : "D3 icon variants exported.");
