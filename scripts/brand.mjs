// Genera el logo de QuéVer y todos sus PNG: favicon e icono de la web, iconos del launcher y banner de Android TV / Fire TV.
// Uso: node scripts/brand.mjs (en el Mac: el nombre usa Avenir Next, que viene con macOS).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const Y = "#ffc83d"; // --accent
const BG = "#0b0d12"; // --bg
const FG = "#f2f4f8"; // --text

// Símbolo en una caja de 100×100: un «play» redondeado con la tilde de «Qué» encima.
export const MARK = `<path d="M34 30 L34 78 L74 54 Z" fill="${Y}" stroke="${Y}" stroke-width="12" stroke-linejoin="round"/><path d="M53 20 L65 9" stroke="${Y}" stroke-width="8" stroke-linecap="round"/>`;

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
// Icono cuadrado: fondo oscuro con esquinas redondeadas (o a sangre para iOS, que ya las redondea).
const icon = (round = true) => svg(100, 100, `<rect width="100" height="100" ${round ? 'rx="22"' : ""} fill="${BG}"/><g transform="translate(8 6) scale(0.84)">${MARK}</g>`);
// Banner 16:9 de la tele (base 320×180): símbolo + «QuéVer».
const banner = () =>
  svg(
    320,
    180,
    `<rect width="320" height="180" fill="${BG}"/><g transform="translate(22 56) scale(0.8)">${MARK}</g>` +
      `<text x="100" y="107" font-family="Avenir Next" font-weight="800" font-size="48" letter-spacing="-1" fill="${FG}">Qué<tspan fill="${Y}">Ver</tspan></text>`,
  );

async function png(source, size, out) {
  const [w, h] = Array.isArray(size) ? size : [size, size];
  const file = join(ROOT, out);
  mkdirSync(dirname(file), { recursive: true });
  await sharp(Buffer.from(source), { density: 72 * (w / Number(/width="(\d+)"/.exec(source)[1])) })
    .resize(w, h)
    .png()
    .toFile(file);
}

const res = "android/app/src/main/res";
const launcher = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const banners = { xhdpi: [320, 180], xxhdpi: [480, 270], xxxhdpi: [640, 360] };

writeFileSync(join(ROOT, "src/app/icon.svg"), icon());
await png(icon(), 512, "src/app/icon.png");
await png(icon(false), 180, "src/app/apple-icon.png");
for (const [d, s] of Object.entries(launcher)) await png(icon(), s, `${res}/mipmap-${d}/ic_launcher.png`);
for (const [d, s] of Object.entries(banners)) await png(banner(), s, `${res}/drawable-${d}/banner.png`);
await png(banner(), [1280, 720], "scripts/brand-preview.png");
console.log("Logo, iconos y banners generados.");
