#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('SOI not found in JPEG');
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5), components: bytes[offset + 7] };
    }
    offset += length;
  }
  throw new Error('JPEG dimensions not found');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngImage(bytes, file) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`PNG signature not found: ${file}`);
  let offset = 8;
  let ihdr;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') ihdr = Buffer.from(data);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (!ihdr || !idat.length) throw new Error(`PNG missing IHDR/IDAT: ${file}`);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) throw new Error(`Unsupported PNG format: ${file}`);
  const sourceChannels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
  const stride = width * sourceChannels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * stride);
  let input = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input++];
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const previous = y ? raw.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[input++];
      const left = x >= sourceChannels ? row[x - sourceChannels] : 0;
      const up = previous ? previous[x] : 0;
      const upperLeft = previous && x >= sourceChannels ? previous[x - sourceChannels] : 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 255;
      else if (filter === 2) row[x] = (value + up) & 255;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (value + paeth(left, up, upperLeft)) & 255;
      else throw new Error(`Unsupported PNG filter ${filter}: ${file}`);
    }
  }
  const gray = colorType === 0 || colorType === 4;
  const components = gray ? 1 : 3;
  const pixels = Buffer.alloc(width * height * components);
  for (let source = 0, target = 0; source < raw.length;) {
    if (colorType === 0) pixels[target++] = raw[source++];
    else if (colorType === 2) { pixels[target++] = raw[source++]; pixels[target++] = raw[source++]; pixels[target++] = raw[source++]; }
    else if (colorType === 4) {
      const value = raw[source++]; const alpha = raw[source++];
      pixels[target++] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    } else {
      const red = raw[source++]; const green = raw[source++]; const blue = raw[source++]; const alpha = raw[source++];
      pixels[target++] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
      pixels[target++] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
      pixels[target++] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width, height, components, bytes: zlib.deflateSync(pixels), filter: '/FlateDecode' };
}

export async function mergeJpegs(files, output) {
  if (!files.length) throw new Error('没有可合并的页面');
  const images = await Promise.all(files.map(async (file) => {
    const bytes = await fsp.readFile(file);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`JPEG EOI not found: ${file}`);
      return { file, bytes, ...jpegSize(bytes), filter: '/DCTDecode' };
    }
    return { file, ...pngImage(bytes, file) };
  }));
  for (const image of images) {
    const ratio = image.width / image.height;
    if (Math.abs(ratio - 16 / 9) > 0.01) throw new Error(`页面不是 16:9，拒绝加边或拉伸：${image.file} (${image.width}x${image.height})`);
  }
  const objects = [];
  const add = (body) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary')); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const pageIds = [];
  const mediaW = 960;
  const mediaH = 540;
  for (const image of images) {
    const imageId = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.components === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter ${image.filter} /Length ${image.bytes.length} >>\nstream\n`, 'binary'),
      image.bytes,
      Buffer.from('\nendstream', 'binary')
    ]));
    const content = Buffer.from(`q\n${mediaW} 0 0 ${mediaH} 0 0 cm\n/Im0 Do\nQ\n`, 'binary');
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'binary'), content, Buffer.from('endstream', 'binary')]));
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${mediaW} ${mediaH}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'binary');
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'binary');
  const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((body, index) => {
    offsets[index + 1] = position;
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'binary'), body, Buffer.from('\nendobj\n', 'binary')]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = position;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  table += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(table, 'binary'));
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, Buffer.concat(chunks));
  return output;
}

async function cli() {
  const [output, ...files] = process.argv.slice(2);
  if (!output || !files.length) throw new Error('用法：merge-jpeg-pdf.mjs <output.pdf> <page1.jpg|png> [...]');
  await mergeJpegs(files.map((file) => path.resolve(file)), path.resolve(output));
  console.log(JSON.stringify({ ok: true, output: path.resolve(output), pages: files.length }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
