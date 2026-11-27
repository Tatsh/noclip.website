import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { isRefPack, decompress } from "./refpack.js";
import { nameHash } from "./namehash.js";

export interface RpkAsset {
    nameHash: number;
    typeId: number;
    offset: number;
    size: number;
    extra: number;
    name: string;
    magic: string;
}

export interface Rpk {
    buf: Uint8Array;
    assets: RpkAsset[];
    strings: string[];
}

function readStr(buf: Uint8Array, offs: number, len: number): string {
    let s = '';
    for (let k = 0; k < len; k++) {
        const c = buf[offs + k];
        if (c === 0)
            break;
        s += String.fromCharCode(c);
    }
    return s;
}

function splitStrings(buf: Uint8Array, start: number, end: number): string[] {
    const out: string[] = [];
    let s = '';
    for (let k = start; k < end; k++) {
        const c = buf[k];
        if (c === 0) {
            if (s.length > 0)
                out.push(s);
            s = '';
        } else {
            s += String.fromCharCode(c);
        }
    }
    if (s.length > 0)
        out.push(s);
    return out;
}

function stem(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    const dot = base.indexOf('.');
    return dot >= 0 ? base.slice(0, dot) : base;
}

function buildNameIndex(strings: string[]): Map<number, string> {
    const index = new Map<number, string>();
    for (const s of strings) {
        if (!s.includes('\\') && !s.includes('/') && !s.includes('.'))
            continue;
        const st = stem(s);
        if (st.length > 0 && !index.has(nameHash(st)))
            index.set(nameHash(st), st);
    }
    return index;
}

function iterAssets(buf: Uint8Array, dv: DataView, group: number, size: number, out: RpkAsset[]): void {
    let j = group + 8;
    const end = group + size;
    while (j + 8 <= end) {
        const tag = readStr(buf, j, 4);
        const cs = dv.getUint32(j + 4, false);
        if (tag === 'ASET') {
            out.push({
                nameHash: dv.getUint32(j + 8, false),
                typeId: dv.getUint32(j + 12, false),
                offset: dv.getUint32(j + 24, false),
                size: dv.getUint32(j + 28, false),
                extra: dv.getUint32(j + 32, false),
                name: '',
                magic: '',
            });
        }
        if (cs < 8)
            break;
        j += cs;
    }
}

export function parseRPK(slice: ArrayBufferSlice): Rpk {
    let buf: Uint8Array = slice.createTypedArray(Uint8Array);
    if (isRefPack(buf))
        buf = decompress(buf);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (readStr(buf, 0, 4) !== 'STRM')
        throw new Error(`Monopoly2008: expected STRM container, got "${readStr(buf, 0, 4)}"`);

    const assets: RpkAsset[] = [];
    let strings: string[] = [];
    const length = buf.length;
    let i = 8;
    while (i + 8 <= length) {
        const tag = readStr(buf, i, 4);
        const size = dv.getUint32(i + 4, false);
        if (size < 8 || i + size > length + 8)
            break;
        if (tag === 'AGRP') {
            iterAssets(buf, dv, i, size, assets);
            i += size;
        } else if (tag === 'STRS') {
            strings = splitStrings(buf, i + 8, i + size);
            i += size;
        } else {
            break;
        }
    }

    const index = buildNameIndex(strings);
    for (const a of assets) {
        a.magic = readStr(buf, a.offset, 4);
        const resolved = index.get(a.nameHash);
        a.name = resolved !== undefined ? resolved : `asset_${(a.nameHash >>> 0).toString(16).padStart(8, '0')}`;
    }
    return { buf, assets, strings };
}
