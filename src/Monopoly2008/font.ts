import type { Rpk } from "./rpk.js";
import type { DecodedTexture } from "./xmap.js";
import type { Npm7Mesh } from "./npm7.js";
import type { BoardPlacement } from "./placements.js";

export interface Glyph {
    width: number;
    height: number;
    x: number;
    y: number;
    bearingX: number;
    bearingY: number;
    advance: number;
}

export interface BitmapFont {
    glyphs: Map<number, Glyph>;
    texture: DecodedTexture;
    lineHeight: number;
}

export function parseFNTX(raw: Uint8Array): BitmapFont {
    if (String.fromCharCode(...raw.subarray(0, 4)) !== 'FntX')
        throw new Error('Monopoly2008: expected FntX font');
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const count = dv.getUint16(0x0a, true);
    const textureHeader = dv.getUint32(0x30, true);
    if (textureHeader + 0x30 > raw.length || 0x80 + count * 16 > textureHeader)
        throw new Error('Monopoly2008: invalid FntX glyph table');
    const width = dv.getUint32(textureHeader + 0x18, true);
    const height = dv.getUint32(textureHeader + 0x1c, true);
    const atlasOffset = textureHeader + dv.getUint32(textureHeader + 0x08, true);
    if (!width || !height || width > 4096 || height > 4096 || atlasOffset + width * height > raw.length)
        throw new Error('Monopoly2008: invalid FntX atlas');
    const glyphs = new Map<number, Glyph>();
    for (let i = 0; i < count; i++) {
        const o = 0x80 + i * 16;
        const glyph: Glyph = {
            width: raw[o + 2], height: raw[o + 3],
            x: dv.getUint16(o + 4, true), y: dv.getUint16(o + 6, true),
            bearingX: dv.getInt8(o + 9), bearingY: dv.getInt8(o + 10),
            advance: dv.getUint16(o + 14, true),
        };
        if (glyph.x + glyph.width > width || glyph.y + glyph.height > height)
            throw new Error(`Monopoly2008: glyph outside FntX atlas at ${i}`);
        glyphs.set(dv.getUint16(o, true), glyph);
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        rgba.fill(255, i * 4, i * 4 + 3);
        rgba[i * 4 + 3] = raw[atlasOffset + i];
    }
    return { glyphs, texture: { width, height, rgba, format: 0 }, lineHeight: dv.getUint16(0x24, true) };
}

export interface PropertyLabel { name: string; price: string; }

const propertyNameHashes = [
    0xaadd521f, 0xabdd5470, 0xa8dd4f39, 0xa9dd508a, 0xaedd58ab, 0xafdd5a3c, 0xacdd55c5,
    0xaddd5756, 0xa2dd4587, 0xa3dd4718, 0x30e06466, 0x2fe06215, 0x32e0674c, 0x31e065fb,
    0x2ce05dda, 0x2be05c49, 0x2ee06080, 0x2de05f2f, 0x28e0570e, 0x27e055bd, 0x9ed8c20d,
    0x9fd8c39e, 0xa0d8c5f3, 0xa1d8c744, 0x9ad8bc41, 0x9bd8bdd2, 0x9cd8bf27, 0x9dd8c0b8,
];
const propertyPriceOffsets = [-5, 5, 3, 5, 3, -3, -5, -3, -5, 5, -3, -5, -3, 3, 5, 3, 5, -5, -3, -5, -5, -3, 3, -3, 3, 5, -5, 5];

function parseLocalizedStrings(rpk: Rpk): Map<number, string> {
    const asset = rpk.assets.find((a) => a.magic === '  XT');
    if (!asset)
        throw new Error('Monopoly2008: missing localized property text');
    const raw = rpk.buf.subarray(asset.offset, asset.offset + asset.size);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const strings = new Map<number, string>();
    for (let offset = 0; offset + 16 <= raw.length;) {
        const hash = dv.getUint32(offset + 8, false);
        const length = dv.getUint32(offset + 12, false);
        offset += 16;
        if (!length || length % 2 || offset + length > raw.length)
            throw new Error('Monopoly2008: invalid localized text record');
        let text = '';
        for (let i = 0; i < length; i += 2) {
            const code = dv.getUint16(offset + i, false);
            if (!code)
                break;
            text += String.fromCharCode(code);
        }
        strings.set(hash, text);
        offset += length;
    }
    return strings;
}

export function parsePropertyNames(rpk: Rpk): PropertyLabel[] {
    const strings = parseLocalizedStrings(rpk);
    return propertyNameHashes.map((hash, index) => {
        const name = strings.get(hash);
        const price = strings.get(hash + propertyPriceOffsets[index]);
        if (!name || !price)
            throw new Error(`Monopoly2008: missing localized property 0x${hash.toString(16)}`);
        return { name, price };
    });
}

const specialTextPlacements: [string, number][] = [
    ['Chance00.Chance_Blue_A', 0x45e860e6], ['Chance01.Chance_Pink_A', 0x44e85e95], ['Chance02.Chance_Red_A', 0x47e863cc],
    ['CommunityChest00.CommunityChest_A', 0x971e8474], ['CommunityChest01.CommunityChest_A', 0x961e82e3], ['CommunityChest02.CommunityChest_A', 0x951e808e],
    ['Tax00.Income_Tax_A', 0x2e251a79], ['Tax00.Income_Tax_C', 0x2e251a7b],
    ['Tax01.Super_Tax_A', 0x2f251bca], ['Tax01.Super_Tax_C', 0x2f251bc8],
    ['Corner_Free_Parking.Corner_Free_Parking_A', 0x67b55e16], ['Corner_Free_Parking.Corner_Free_Parking_B', 0x67b55e15],
    ['Corner_GoTo_Jail.Corner_GoTo_Jail_A', 0x634bb44d], ['Corner_GoTo_Jail.Corner_GoTo_Jail_B', 0x634bb44e],
    ['Corner_Jail.Corner_Jail_A', 0x6f396dc1], ['Corner_Jail.Corner_Jail_B', 0x6f396dc2],
];

export function parseSpecialNames(rpk: Rpk, boardId: string): Map<string, string> {
    const strings = parseLocalizedStrings(rpk);
    const out = new Map<string, string>();
    for (const [place, hash] of specialTextPlacements) {
        const text = strings.get(hash);
        if (text)
            out.set(place, text);
    }
    const go = boardId === 'classic' ? strings.get(0x2c7fa86f) || strings.get(0x2c7fa86c) : strings.get(0x2c7fa869);
    if (go)
        out.set('Corner_Go.Corner_Go_A', go);
    return out;
}

export const boardFontTextureName = 'monopoly_board_font';

export function buildPropertyTextMesh(font: BitmapFont, labels: PropertyLabel[], places: Map<string, BoardPlacement>, special: Map<string, string>, boardId = ''): Npm7Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const bmin: [number, number, number] = [Infinity, Infinity, Infinity];
    const bmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const measure = (line: string) => [...line].reduce((sum, ch) => sum + (font.glyphs.get(ch.codePointAt(0)!)?.advance ?? 0), 0);

    const draw = (value: string, place: BoardPlacement, wrap: boolean, shift = 0, fit = false) => {
        const regionWidth = Math.hypot(...place.across);
        const regionHeight = Math.hypot(...place.inward);
        if (!regionWidth || !regionHeight)
            return;
        if (place.textColor === undefined)
            throw new Error('Monopoly2008: missing board text color');
        const color = place.textColor;
        const nominalScale = (place.textLineHeight ?? 1) / font.lineHeight;
        const lineWidth = regionWidth / nominalScale;
        const words = value.replaceAll('-', '- ').split(' ');
        const lines: string[] = [];
        if (wrap && fit && words.length > 1) {
            let split = 1;
            for (let i = 2; i < words.length; i++)
                if (Math.max(measure(words.slice(0, i).join(' ')), measure(words.slice(i).join(' '))) <
                    Math.max(measure(words.slice(0, split).join(' ')), measure(words.slice(split).join(' '))))
                    split = i;
            lines.push(words.slice(0, split).join(' '), words.slice(split).join(' '));
        } else if (wrap) {
            for (const word of words) {
                const candidate = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
                if (lines.length && measure(candidate) > lineWidth)
                    lines.push(word);
                else if (lines.length)
                    lines[lines.length - 1] = candidate;
                else
                    lines.push(word);
            }
        } else {
            lines.push(value);
        }
        // shortcut: GO uses a fitted label until its XEX placement rule is decoded.
        const scale = fit ? Math.min(nominalScale, regionWidth * 0.88 / Math.max(...lines.map(measure))) : nominalScale;
        const across = place.across.map((v) => v / regionWidth);
        const inward = place.inward.map((v) => v / regionHeight);
        lines.forEach((line, row) => {
            let cursor = -measure(line) / 2;
            for (const ch of line) {
                const glyph = font.glyphs.get(ch.codePointAt(0)!);
                if (!glyph)
                    throw new Error(`Monopoly2008: missing glyph ${ch}`);
                if (glyph.width && glyph.height) {
                    const x0 = (cursor + glyph.bearingX) * scale;
                    const x1 = x0 + glyph.width * scale;
                    const y0 = (lines.length * font.lineHeight / 2 - row * font.lineHeight - glyph.bearingY) * scale;
                    const y1 = y0 - glyph.height * scale;
                    const left = Math.max(x0, -regionWidth / 2), right = Math.min(x1, regionWidth / 2);
                    const top = fit ? y0 : Math.min(y0, regionHeight / 2 - shift);
                    const bottom = fit ? y1 : Math.max(y1, -regionHeight / 2 - shift);
                    if (left >= right || bottom >= top) {
                        cursor += glyph.advance;
                        continue;
                    }
                    const u0 = (glyph.x + (left - x0) / scale) / font.texture.width;
                    const u1 = (glyph.x + (right - x0) / scale) / font.texture.width;
                    const v0 = (glyph.y + (y0 - top) / scale) / font.texture.height;
                    const v1 = (glyph.y + (y0 - bottom) / scale) / font.texture.height;
                    const corners = [[left, top, u0, v0], [right, top, u1, v0], [right, bottom, u1, v1], [left, bottom, u0, v1]];
                    const base = positions.length / 3;
                    for (const [x, y, u, v] of corners) {
                        const px = place.position[0] + across[0] * x + inward[0] * (y + shift);
                        const pz = place.position[2] + across[1] * x + inward[1] * (y + shift);
                        positions.push(px, place.position[1] + 0.01, pz);
                        normals.push(0, 1, 0);
                        uvs.push(u, v);
                        colors.push(((color >>> 16) & 255) / 255, ((color >>> 8) & 255) / 255, (color & 255) / 255, (color >>> 24) / 255);
                        bmin[0] = Math.min(bmin[0], px); bmin[1] = Math.min(bmin[1], place.position[1] + 0.01); bmin[2] = Math.min(bmin[2], pz);
                        bmax[0] = Math.max(bmax[0], px); bmax[1] = Math.max(bmax[1], place.position[1] + 0.01); bmax[2] = Math.max(bmax[2], pz);
                    }
                    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                }
                cursor += glyph.advance;
            }
        });
    };

    labels.forEach((label, index) => {
        const prefix = `Property${String(index).padStart(2, '0')}.`;
        const innerEntry = [...places.entries()].find(([name]) => name.startsWith(prefix) && name.endsWith('_A'));
        const inner = innerEntry?.[1];
        const outer = [...places.entries()].find(([name]) => name.startsWith(prefix) && name.endsWith('_C'))?.[1];
        if (!inner || !outer)
            throw new Error(`Monopoly2008: missing text placement for ${prefix}`);
        const picture = /_(Station|Utility)_A$/.test(innerEntry![0]);
        draw(label.name, inner, !picture, 0, picture);
        draw(label.price, outer, false);
    });
    for (const [name, value] of special) {
        if (!value)
            continue;
        const place = places.get(name);
        if (!place)
            throw new Error(`Monopoly2008: missing text placement ${name}`);
        const go = name === 'Corner_Go.Corner_Go_A';
        const goWrap = go && measure(value) * (place.textLineHeight ?? 1) / font.lineHeight > Math.hypot(...place.across) * 1.2;
        const goShift = boardId === 'sipod' || boardId === 'deco' || boardId === 'sweet' ? 0.75 : goWrap ? 0.8 : 0.6;
        draw(value, place, !go || goWrap, go ? Math.hypot(...place.inward) * goShift : 0, go);
    }
    return {
        format: 'FntX', transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], pivot: [0, 0, 0], bmin, bmax,
        materials: [{ textures: [{ name: boardFontTextureName, type: 0, slot: 0 }], renderMode: 2, shaderType: 1, featureFlags: 4 }],
        submeshes: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), colors: Float32Array.from(colors), indices: Uint32Array.from(indices), materialIndex: 0 }],
    };
}
