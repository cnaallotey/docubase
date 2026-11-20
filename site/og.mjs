// Social cards for the Docubase website: 1200 by 630 PNGs, one per page, drawn as SVG and rasterized
// with resvg. The dot wave uses the same maths as the WebGL field in src/assets/scene.js, so a link
// preview looks like the page it opens.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const require = createRequire(import.meta.url);

/** WOFF 1.0 to a plain TrueType/OpenType font, because resvg reads only the plain formats. */
export function woffToSfnt(woff) {
  if (woff.toString('ascii', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 font');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({ tag: woff.subarray(at, at + 4), checksum: woff.readUInt32BE(at + 16), data: compLength < origLength ? inflateSync(raw) : raw });
  }
  const pad = (n) => (n + 3) & ~3;
  const headerSize = 12 + numTables * 16;
  const total = tables.reduce((sum, t) => sum + pad(t.data.length), headerSize);
  const out = Buffer.alloc(total);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = 2 ** entrySelector * 16;
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let offset = headerSize;
  tables.forEach((t, i) => {
    const at = 12 + i * 16;
    t.tag.copy(out, at);
    out.writeUInt32BE(t.checksum, at + 4);
    out.writeUInt32BE(offset, at + 8);
    out.writeUInt32BE(t.data.length, at + 12);
    t.data.copy(out, offset);
    offset += pad(t.data.length);
  });
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function seeded(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal PNG encoder for an RGBA buffer. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The dot wave, projected on the CPU with the shader's maths and drawn straight into pixels (far faster
 * than thousands of SVG shapes). Returns a PNG data URI with a transparent background.
 */
// Eight wave shapes are enough variety across cards, and caching them keeps the build quick.
const fields = new Map();
function dotField(seed) {
  const key = Math.floor(seeded(seed)() * 8);
  if (!fields.has(key)) fields.set(key, drawField(`wave-${key}`));
  return fields.get(key);
}

function drawField(seed) {
  const rand = seeded(seed);
  const W = 22, D = 18, camH = 1.9, pitch = 0.42, fov = 62;
  const [slope, offset, width] = [-1.15, -2.9, 1.15];
  const aspect = CARD_WIDTH / CARD_HEIGHT;
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  const t = 2 + rand() * 40;
  const ca = Math.cos(pitch), sa = Math.sin(pitch);
  const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  // Premultiplied colour, added up like the WebGL field's additive blending, then clamped.
  const acc = new Float32Array(CARD_WIDTH * CARD_HEIGHT * 4);
  const cols = 240, rows = 140;
  for (let j = 0; j < rows; j++) {
    const v = Math.pow(j / (rows - 1), 1.35);
    for (let i = 0; i < cols; i++) {
      const tw = 0.72 + 0.28 * Math.sin(rand() * 60);
      const x = (i / (cols - 1) - 0.5) * W;
      const z = -v * D - 0.6;
      const h = 0.34 * Math.sin(x * 0.55 + z * 0.38 - t * 0.7) + 0.18 * Math.sin(x * -1.1 + z * 0.8 + t * 0.55) + 0.07 * Math.sin(x * 2.3 - z * 1.7 + t * 1.3);
      const zc = offset + x * slope + 1.2 * Math.sin(x * 0.32 + t * 0.18);
      const dz = (z - zc) / width;
      const band = Math.exp(-dz * dz);
      const y = h * (0.5 + band * 1.2) - 0.3;
      const qy = y - camH;
      const ry = qy * ca - z * sa;
      const rz = qy * sa + z * ca;
      if (rz >= -0.05) continue;
      const sx = (((x * f) / aspect / -rz) * 0.5 + 0.5) * CARD_WIDTH;
      const sy = (1 - (((ry * f) / -rz) * 0.5 + 0.5)) * CARD_HEIGHT;
      const crest = smooth(0.05, 0.45, h);
      const fog = smooth(D + 0.6, D * 0.45, -z) * smooth(W * 0.5, W * 0.36, Math.abs(x));
      const alpha = Math.min(1, (0.12 + band * (0.42 + crest * 1.1)) * fog * tw);
      if (alpha < 0.03) continue;
      const hot = Math.min(1, crest * band * 1.4);
      const size = Math.min(7, Math.max(1.5, ((1 + band * 0.7) * 1.6 * 7) / -rz));
      const r = (0.86 + (0.984 - 0.86) * hot) * alpha, g = (0.87 + (1 - 0.87) * hot) * alpha, b = (0.84 + (0.33 - 0.84) * hot) * alpha;
      const x0 = Math.max(0, Math.round(sx - size / 2)), x1 = Math.min(CARD_WIDTH, Math.round(sx + size / 2));
      const y0 = Math.max(0, Math.round(sy - size / 2)), y1 = Math.min(CARD_HEIGHT, Math.round(sy + size / 2));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const k = (py * CARD_WIDTH + px) * 4;
          acc[k] += r; acc[k + 1] += g; acc[k + 2] += b; acc[k + 3] += alpha;
        }
      }
    }
  }
  const rgba = Buffer.alloc(CARD_WIDTH * CARD_HEIGHT * 4);
  for (let k = 0; k < acc.length; k += 4) {
    const a = Math.min(1, acc[k + 3]);
    if (a <= 0) continue;
    // Back from premultiplied, so resvg composites it over the black card as normal alpha.
    const scale = 1 / Math.max(acc[k + 3], 1e-6);
    rgba[k] = Math.min(255, Math.round(acc[k] * scale * 255));
    rgba[k + 1] = Math.min(255, Math.round(acc[k + 1] * scale * 255));
    rgba[k + 2] = Math.min(255, Math.round(acc[k + 2] * scale * 255));
    rgba[k + 3] = Math.round(a * 255);
  }
  return `data:image/png;base64,${encodePng(CARD_WIDTH, CARD_HEIGHT, rgba).toString('base64')}`;
}

// Rough advance widths for Geist, in ems, good enough to break lines before resvg draws them.
function textWidth(text, size) {
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += 0.26;
    else if ('il.,:;!|\'’`'.includes(ch)) em += 0.25;
    else if ('fjrtI()[]'.includes(ch)) em += 0.34;
    else if ('mwMW'.includes(ch)) em += 0.82;
    else if (/[A-Z]/.test(ch)) em += 0.66;
    else if (/[0-9]/.test(ch)) em += 0.58;
    else em += 0.53;
  }
  return em * size * 0.97;
}

// A newline in the text forces a break; otherwise words fill each line up to maxWidth.
function wrap(text, size, maxWidth, maxLines) {
  const lines = [];
  for (const part of String(text).split('\n')) {
    let line = '';
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && textWidth(`${last}…`, size) > maxWidth) last = last.replace(/\s*\S+$/, '');
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

export function cardSvg({ title, description = '', label = '', url = '', seed = title }) {
  const pad = 80;
  const maxWidth = 860;
  let size = 84;
  let titleLines = wrap(title, size, maxWidth, 3);
  while (size > 56 && (titleLines.length > 2 || titleLines.some((l) => textWidth(l, size) > maxWidth))) {
    size -= 6;
    titleLines = wrap(title, size, maxWidth, 3);
  }
  const lead = size * 1.04;
  const descLines = description ? wrap(description, 28, 780, 2) : [];
  const blockHeight = titleLines.length * lead + (descLines.length ? 28 + descLines.length * 40 : 0);
  const top = Math.max(200, 330 - blockHeight / 2 + size * 0.8);
  const titleSvg = titleLines.map((l, i) => `<tspan x="${pad}" y="${(top + i * lead).toFixed(1)}">${esc(l)}</tspan>`).join('');
  const descTop = top + (titleLines.length - 1) * lead + 64;
  const descSvg = descLines.map((l, i) => `<tspan x="${pad}" y="${(descTop + i * 40).toFixed(1)}">${esc(l)}</tspan>`).join('');
  const labelWidth = label ? textWidth(label, 22) + 64 : 0;
  const bar = (rot) => `<rect x="${pad + 9.5}" y="72" width="7" height="34" rx="3.5" fill="#ffffff" transform="rotate(${rot} ${pad + 13} 89)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
<defs>
<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#050506" stop-opacity="0.94"/><stop offset="0.5" stop-color="#050506" stop-opacity="0.7"/><stop offset="0.85" stop-color="#050506" stop-opacity="0"/></linearGradient>
<radialGradient id="glow" cx="0.78" cy="1.05" r="0.6"><stop offset="0" stop-color="#fbff54" stop-opacity="0.22"/><stop offset="1" stop-color="#fbff54" stop-opacity="0"/></radialGradient>
</defs>
<rect width="100%" height="100%" fill="#050506"/>
<rect width="100%" height="100%" fill="url(#glow)"/>
<image width="${CARD_WIDTH}" height="${CARD_HEIGHT}" href="${dotField(seed)}"/>
<rect width="100%" height="100%" fill="url(#shade)"/>
${bar(0)}${bar(60)}${bar(-60)}
<text x="${pad + 46}" y="101" font-family="Geist" font-weight="500" font-size="34" letter-spacing="-1" fill="#ffffff">docubase</text>
${label ? `<rect x="${CARD_WIDTH - pad - labelWidth}" y="66" width="${labelWidth}" height="46" rx="23" fill="#fbff54"/>
<text x="${CARD_WIDTH - pad - labelWidth / 2}" y="96" text-anchor="middle" font-family="Geist" font-weight="500" font-size="22" fill="#111112">${esc(label)}</text>` : ''}
<text font-family="Geist" font-weight="400" font-size="${size}" letter-spacing="${(-size * 0.04).toFixed(1)}" fill="#ffffff">${titleSvg}</text>
${descSvg ? `<text font-family="Geist" font-weight="400" font-size="28" fill="#ffffff" fill-opacity="0.64">${descSvg}</text>` : ''}
${url ? `<text x="${pad}" y="${CARD_HEIGHT - 64}" font-family="Geist Mono" font-size="20" fill="#ffffff" fill-opacity="0.42">${esc(url)}</text>` : ''}
</svg>`;
}

/** Loads the fonts once and returns a function that turns card options into a PNG buffer. */
export async function createCardRenderer() {
  // resvg reads fonts from files, so the WOFF files from npm are unpacked into a temporary folder.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docubase-og-'));
  const fontFiles = [];
  for (const [pkg, file] of [['geist', 'geist-latin-400-normal.woff'], ['geist', 'geist-latin-500-normal.woff'], ['geist-mono', 'geist-mono-latin-400-normal.woff']]) {
    const target = path.join(dir, file.replace(/\.woff$/, '.ttf'));
    await writeFile(target, woffToSfnt(await readFile(path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file))));
    fontFiles.push(target);
  }
  return (options) => {
    const resvg = new Resvg(cardSvg(options), {
      font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist' },
      fitTo: { mode: 'width', value: CARD_WIDTH },
    });
    return resvg.render().asPng();
  };
}
