const GPU_DXT1 = 0x12;
const GPU_DXT4_5 = 0x14;
const GPU_8888 = 0x06;
const GPU_DXN = 0x31;

export interface DecodedTexture {
    width: number;
    height: number;
    rgba: Uint8Array;
    mips?: Uint8Array[];
    format: number;
}

function tiledX(offset: number, width: number, texelPitch: number): number {
    const alignedWidth = (width + 31) & ~31;
    const logBpp = (texelPitch >> 2) + ((texelPitch >> 1) >> (texelPitch >> 2));
    const ob = offset << logBpp;
    const ot = ((ob & ~4095) >> 3) + ((ob & 1792) >> 2) + (ob & 63);
    const om = ot >> (7 + logBpp);
    const macroX = (om % (alignedWidth >> 5)) << 2;
    const tile = (((ot >> (5 + logBpp)) & 2) + (ob >> 6)) & 3;
    const macro = (macroX + tile) << 3;
    const micro = ((((ot >> 1) & ~15) + (ot & 15)) & ((texelPitch << 3) - 1)) >> logBpp;
    return macro + micro;
}

function tiledY(offset: number, width: number, texelPitch: number): number {
    const alignedWidth = (width + 31) & ~31;
    const logBpp = (texelPitch >> 2) + ((texelPitch >> 1) >> (texelPitch >> 2));
    const ob = offset << logBpp;
    const ot = ((ob & ~4095) >> 3) + ((ob & 1792) >> 2) + (ob & 63);
    const om = ot >> (7 + logBpp);
    const macroY = Math.floor(om / (alignedWidth >> 5)) << 2;
    const tile = ((ot >> (6 + logBpp)) & 1) + ((ob & 2048) >> 10);
    const macro = (macroY + tile) << 3;
    const micro = (((ot & (((texelPitch << 6) - 1) & ~31)) + ((ot & 15) << 1)) >> (3 + logBpp)) & ~1;
    return macro + micro + ((ot & 16) >> 4);
}

function untile(data: Uint8Array, blocksW: number, blocksH: number, elem: number): Uint8Array {
    const n = blocksW * blocksH * elem;
    const out = new Uint8Array(n);
    for (let j = 0; j < blocksH; j++) {
        for (let i = 0; i < blocksW; i++) {
            const lin = j * blocksW + i;
            const x = tiledX(lin, blocksW, elem);
            const y = tiledY(lin, blocksW, elem);
            const d = (y * blocksW + x) * elem;
            const s = lin * elem;
            if (d >= 0 && d + elem <= n && s + elem <= data.length)
                out.set(data.subarray(s, s + elem), d);
        }
    }
    return out;
}

function untileCrop(data: Uint8Array, ew: number, eh: number, elem: number, offsetX = 0, offsetY = 0, gridW = 0, gridH = 0): Uint8Array {
    const awe = gridW || ((ew + offsetX + 31) & ~31);
    const ahe = gridH || ((eh + offsetY + 31) & ~31);
    if (offsetX + ew > awe || offsetY + eh > ahe)
        throw new Error('Monopoly2008: XMAP mip exceeds tiled grid');
    const need = awe * ahe * elem;
    let tiled = data;
    if (data.length < need) {
        tiled = new Uint8Array(need);
        tiled.set(data);
    } else if (data.length > need) {
        tiled = data.subarray(0, need);
    }
    const aligned = untile(tiled, awe, ahe, elem);
    const out = new Uint8Array(ew * eh * elem);
    const row = ew * elem, arow = awe * elem;
    for (let j = 0; j < eh; j++)
        out.set(aligned.subarray((j + offsetY) * arow + offsetX * elem, (j + offsetY) * arow + offsetX * elem + row), j * row);
    return out;
}

function swap16(b: Uint8Array): Uint8Array {
    const out = new Uint8Array(b.length);
    for (let i = 0; i + 1 < b.length; i += 2) {
        out[i] = b[i + 1];
        out[i + 1] = b[i];
    }
    return out;
}

function swap32(b: Uint8Array): Uint8Array {
    const out = new Uint8Array(b.length);
    for (let i = 0; i + 3 < b.length; i += 4) {
        out[i] = b[i + 3];
        out[i + 1] = b[i + 2];
        out[i + 2] = b[i + 1];
        out[i + 3] = b[i];
    }
    return out;
}

function color565(c: number): [number, number, number] {
    const r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeDXT1(data: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
    let p = 0;
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true);
            const bits = dv.getUint32(p + 4, true);
            p += 8;
            const [r0, g0, b0] = color565(c0);
            const [r1, g1, b1] = color565(c1);
            const pal = [[r0, g0, b0, 255], [r1, g1, b1, 255], [0, 0, 0, 255], [0, 0, 0, 0]];
            if (c0 > c1) {
                pal[2] = [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0, 255];
                pal[3] = [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0, 255];
            } else {
                pal[2] = [(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1, 255];
                pal[3] = [0, 0, 0, 0];
            }
            for (let i = 0; i < 16; i++) {
                const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
                if (px < w && py < h) {
                    const c = pal[(bits >>> (2 * i)) & 3];
                    const o = (py * w + px) * 4;
                    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
                }
            }
        }
    }
    return out;
}

function alphaRamp(a0: number, a1: number): number[] {
    const at = [a0, a1];
    if (a0 > a1)
        for (let j = 1; j < 7; j++) at.push(((7 - j) * a0 + j * a1) / 7 | 0);
    else {
        for (let j = 1; j < 5; j++) at.push(((5 - j) * a0 + j * a1) / 5 | 0);
        at.push(0, 255);
    }
    return at;
}

function read48(data: Uint8Array, p: number): number {
    let lo = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
    lo += data[p + 3] * 0x1000000;
    return lo + (data[p + 4] + data[p + 5] * 256) * 0x100000000;
}

function decodeDXT5(data: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
    let p = 0;
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const at = alphaRamp(data[p], data[p + 1]);
            const abits = read48(data, p + 2);
            const c0 = dv.getUint16(p + 8, true), c1 = dv.getUint16(p + 10, true);
            const bits = dv.getUint32(p + 12, true);
            p += 16;
            const [r0, g0, b0] = color565(c0);
            const [r1, g1, b1] = color565(c1);
            const pal = [[r0, g0, b0], [r1, g1, b1],
                [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0],
                [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0]];
            for (let i = 0; i < 16; i++) {
                const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
                if (px < w && py < h) {
                    const c = pal[(bits >>> (2 * i)) & 3];
                    const a = at[Math.floor(abits / Math.pow(2, 3 * i)) & 7];
                    const o = (py * w + px) * 4;
                    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a;
                }
            }
        }
    }
    return out;
}

function decodeAlphaBlock(data: Uint8Array, p: number): number[] {
    const at = alphaRamp(data[p], data[p + 1]);
    const bits = read48(data, p + 2);
    const out: number[] = [];
    for (let i = 0; i < 16; i++)
        out.push(at[Math.floor(bits / Math.pow(2, 3 * i)) & 7]);
    return out;
}

function decodeDXN(data: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
    let p = 0;
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const red = decodeAlphaBlock(data, p);
            const grn = decodeAlphaBlock(data, p + 8);
            p += 16;
            for (let i = 0; i < 16; i++) {
                const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
                if (px < w && py < h) {
                    const r = red[i], g = grn[i];
                    const nx = r / 127.5 - 1.0, ny = g / 127.5 - 1.0;
                    const nz = Math.sqrt(Math.max(0.0, 1.0 - nx * nx - ny * ny));
                    const o = (py * w + px) * 4;
                    out[o] = r; out[o + 1] = g; out[o + 2] = (nz + 1.0) * 127.5 | 0; out[o + 3] = 255;
                }
            }
        }
    }
    return out;
}

export function decodeXMAP(buf: Uint8Array): DecodedTexture {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!(buf[0] === 0x50 && buf[1] === 0x41 && buf[2] === 0x4D && buf[3] === 0x58))
        throw new Error('Monopoly2008: not a PAMX texture');
    const w = dv.getUint32(0x10, true);
    const h = dv.getUint32(0x14, true);
    const fmt = dv.getUint32(0x1C, true) & 0x3F;
    const mipCount = dv.getUint32(0x18, true);
    const data = buf.subarray(32);
    if (fmt !== GPU_DXT1 && fmt !== GPU_DXT4_5 && fmt !== GPU_DXN && fmt !== GPU_8888)
        throw new Error(`Monopoly2008: unsupported GPU texture format 0x${fmt.toString(16)}`);
    if (mipCount < 1 || mipCount > 16 || !w || !h)
        throw new Error('Monopoly2008: invalid XMAP dimensions or mip count');
    const blockSize = fmt === GPU_8888 ? 1 : 4;
    const elem = fmt === GPU_DXT1 ? 8 : fmt === GPU_8888 ? 4 : 16;
    const mips: Uint8Array[] = [];
    let offset = 0, packedBase = -1, packedOffset = 0, packedGridW = 0, packedGridH = 0;
    for (let level = 0; level < mipCount; level++) {
        const mw = Math.max(1, w >> level), mh = Math.max(1, h >> level);
        const bw = Math.ceil(mw / blockSize), bh = Math.ceil(mh / blockSize);
        const packed = mipCount > 1 && Math.min(mw, mh) <= 16;
        let tileX = 0, tileY = 0;
        if (packed) {
            const tile = packedBase < 0 ? 0 : level - packedBase;
            const step = tile < 3 ? 16 >> tile : 16 >> (tile - 2);
            if (mw > mh) tileY = Math.floor(step / blockSize);
            else tileX = Math.floor(step / blockSize);
            if (tile >= 3) [tileX, tileY] = [tileY, tileX];
            if (packedBase < 0) {
                packedBase = level;
                packedOffset = offset;
                packedGridW = (bw + tileX + 31) & ~31;
                packedGridH = (bh + tileY + 31) & ~31;
                offset += packedGridW * packedGridH * elem;
            }
        }
        const sourceOffset = packed ? packedOffset : offset;
        const bytes = packed ? packedGridW * packedGridH * elem : ((bw + 31) & ~31) * ((bh + 31) & ~31) * elem;
        if (sourceOffset + bytes > data.length)
            throw new Error(`Monopoly2008: truncated XMAP mip ${level}`);
        const raw = untileCrop(data.subarray(sourceOffset, sourceOffset + bytes), bw, bh, elem, tileX, tileY, packed ? packedGridW : 0, packed ? packedGridH : 0);
        if (!packed) offset += bytes;
        if (fmt === GPU_8888) {
            mips.push(swap32(raw));
        } else {
            const lin = swap16(raw);
            mips.push(fmt === GPU_DXT1 ? decodeDXT1(lin, mw, mh)
                : fmt === GPU_DXT4_5 ? decodeDXT5(lin, mw, mh) : decodeDXN(lin, mw, mh));
        }
    }
    if (offset !== data.length)
        throw new Error(`Monopoly2008: XMAP mip data size mismatch (${offset} != ${data.length})`);
    return { width: w, height: h, rgba: mips[0], mips, format: fmt };
}
