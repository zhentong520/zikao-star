/**
 * 生成 PWA 图标 PNG（无依赖，手写最小 PNG 编码器）
 * 用法：node make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 绘制：圆角渐变底 + 书本 + 星星 ----
function draw(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const R = maskable ? size * 0.5 : size * 0.223;   // maskable 用整圆
  const pad = maskable ? 0 : 0;
  const set = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    const na = a / 255, ia = 1 - na;
    px[i] = Math.round(r * na + px[i] * ia);
    px[i + 1] = Math.round(g * na + px[i + 1] * ia);
    px[i + 2] = Math.round(b * na + px[i + 2] * ia);
    px[i + 3] = Math.max(px[i + 3], a);
  };
  // 背景渐变圆角
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      if (!maskable) {
        const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
        if (cx < R && cy < R) inside = (R - cx) ** 2 + (R - cy) ** 2 <= R * R;
      }
      if (!inside) continue;
      const t = (x + y) / (size * 2);
      set(x, y, Math.round(255 - t * 0), Math.round(177 - t * 40), Math.round(153 - t * 25), 255);
    }
  }
  const S = size / 100;
  // 书本（左页）
  const bookTop = 34 * S, bookBot = 84 * S;
  for (let y = Math.floor(bookTop); y < bookBot; y++) {
    for (let x = Math.floor(27 * S); x < 50 * S; x++) {
      const t = (x - 27 * S) / (23 * S);
      if (t > 0.86 && y < bookBot - 6 * S * (1 - t)) continue;   // 斜边
      set(x, y, 255, 255, 255, 242);
    }
  }
  // 书本（右页）
  for (let y = Math.floor(bookTop); y < bookBot; y++) {
    for (let x = Math.floor(50 * S); x < 73 * S; x++) {
      const t = (73 * S - x) / (23 * S);
      if (t > 0.86 && y < bookBot - 6 * S * (1 - t)) continue;
      set(x, y, 255, 255, 255, 200);
    }
  }
  // 书脊
  for (let y = Math.floor(bookTop + 2 * S); y < bookBot; y++)
    for (let x = Math.floor(49 * S); x < 51 * S; x++) set(x, y, 255, 138, 122, 255);
  // 星星（五角，居上）
  const sc = 13 * S, scy = 22 * S, scx = 50 * S;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 5;
    const rr = i % 2 === 0 ? sc : sc * 0.44;
    pts.push([scx + Math.cos(ang) * rr, scy + Math.sin(ang) * rr]);
  }
  const insideStar = (x, y) => {
    let c = false;
    for (let i = 0, j = 9; i < 10; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = Math.floor(scy - sc - 2); y < scy + sc + 2; y++)
    for (let x = Math.floor(scx - sc - 2); x < scx + sc + 2; x++)
      if (insideStar(x, y)) set(x, y, 255, 214, 107, 255);
  return png(size, size, px);
}

const out = path.join(__dirname);
const targets = [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'icon-180.png'], [512, 'icon-maskable.png']];

// 作为模块被引用时（Android 图标生成）只导出 draw，不写文件
if (require.main === module) {
  for (const [s, name] of targets) {
    const buf = draw(s, name.includes('maskable'));
    fs.writeFileSync(path.join(out, name), buf);
    console.log('✅', name, (buf.length / 1024).toFixed(1) + 'KB');
  }
}
module.exports = { draw };
