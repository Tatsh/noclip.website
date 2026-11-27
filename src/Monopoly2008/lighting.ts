import type { Rpk } from './rpk.js';

export interface RoomLighting {
    ambient: [number, number, number];
    lights: { direction: [number, number, number], color: [number, number, number], intensity: number }[];
}

const colourHash = 0x06a636c2;
const intensityHash = 0x0ac5f0e9;

export function parseRoomLighting(rpk: Rpk): RoomLighting | undefined {
    const assets = rpk.assets.filter(a => a.name.startsWith('DirectionalLight') || /^WW_[123]_NG$/.test(a.name) || a.name.includes('SceneAmbient'));
    if (assets.length === 0)
        return undefined;
    const lighting: RoomLighting = { ambient: [0, 0, 0], lights: [] };
    for (const asset of assets) {
        const raw = rpk.buf.subarray(asset.offset, asset.offset + asset.size);
        if (raw.length < 0x80 || new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, false) !== 0x66600001)
            throw new Error(`Monopoly2008: invalid light entity ${asset.name}`);
        const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        let colour: number | undefined;
        let intensity: number | undefined;
        for (let offset = 0x70; offset + 12 <= raw.length; offset += 4) {
            if (data.getUint32(offset + 4, false) !== 4)
                continue;
            const hash = data.getUint32(offset, false);
            if (hash === colourHash)
                colour = data.getUint32(offset + 8, false);
            else if (hash === intensityHash)
                intensity = data.getFloat32(offset + 8, false);
        }
        if (colour === undefined || intensity === undefined || !Number.isFinite(intensity))
            throw new Error(`Monopoly2008: incomplete light entity ${asset.name}`);
        const color: [number, number, number] = [(colour >>> 16 & 255) / 255, (colour >>> 8 & 255) / 255, (colour & 255) / 255];
        if (asset.name.includes('SceneAmbient')) {
            lighting.ambient = color.map(channel => channel * intensity) as [number, number, number];
        } else {
            const direction: [number, number, number] = [data.getFloat32(0x30, false), data.getFloat32(0x34, false), data.getFloat32(0x38, false)];
            if (!direction.every(Number.isFinite))
                throw new Error(`Monopoly2008: invalid light direction ${asset.name}`);
            lighting.lights.push({ direction, color, intensity });
        }
    }
    if (lighting.lights.length > 3)
        throw new Error('Monopoly2008: more than three room directional lights');
    return lighting;
}
