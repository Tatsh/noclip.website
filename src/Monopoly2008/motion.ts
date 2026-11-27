import type { Npm7Mesh } from './npm7.js';
import { mat4, quat } from 'gl-matrix';

export interface CharacterSkeleton {
    character: number;
    parents: number[];
    inverseBinds: Float32Array[];
}

export function parseCharacterSkeleton(raw: Uint8Array): CharacterSkeleton {
    const blob = raw.subarray(0x10);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const u32 = (o: number) => dv.getUint32(o, false);
    const record = u32(0x1c), count = u32(record + 4);
    const links = u32(record + 8), matrices = u32(record + 12);
    if (!count || count > 256 || links + count * 20 > blob.length || matrices + count * 64 > blob.length)
        throw new Error('Monopoly2008: invalid character skeleton');
    return {
        character: u32(8),
        parents: Array.from({ length: count }, (_, i) => dv.getInt32(links + i * 20, false)),
        inverseBinds: Array.from({ length: count }, (_, bone) => Float32Array.from({ length: 16 },
            (_, i) => dv.getFloat32(matrices + bone * 64 + i * 4, false))),
    };
}

export function matchMeshBones(mesh: Npm7Mesh, skeleton: CharacterSkeleton): number[] {
    if (!mesh.skin) throw new Error('Monopoly2008: character mesh has no skin');
    const mapping: number[] = [];
    for (let bone = 0; bone < mesh.skin.parents.length; bone++) {
        const inverse = mesh.skin.inverseBinds[bone];
        const candidates = skeleton.inverseBinds.map((other, i) => ({ other, i })).filter(({ other, i }) =>
            !mapping.includes(i) && other.every((value, j) => Math.abs(value - inverse[j]) < 1e-4));
        if (!candidates.length) throw new Error(`Monopoly2008: unmatched mesh bone ${bone}`);
        const parent = mesh.skin.parents[bone] < 0 ? -1 : mapping[mesh.skin.parents[bone]];
        mapping.push((candidates.find(({ i }) => skeleton.parents[i] === parent) ?? candidates[0]).i);
    }
    return mapping;
}

export class SkinPose {
    private restTranslations: [number, number, number][];
    private mapping: number[];
    private worlds: mat4[];
    public matrices: mat4[];
    private lastFrame = -1;

    constructor(mesh: Npm7Mesh, private skeleton: CharacterSkeleton, private clip: MotionClip) {
        if (!mesh.skin || clip.frames.some((frame) => frame.length !== skeleton.parents.length))
            throw new Error('Monopoly2008: idle motion does not match character skeleton');
        this.mapping = matchMeshBones(mesh, skeleton);
        this.worlds = skeleton.parents.map(() => mat4.create());
        this.matrices = this.mapping.map(() => mat4.create());
        this.restTranslations = skeleton.inverseBinds.map((inverse, bone) => {
            const restWorld = mat4.invert(mat4.create(), inverse);
            if (!restWorld) throw new Error(`Monopoly2008: singular inverse bind ${bone}`);
            const parent = skeleton.parents[bone];
            const local = parent < 0 ? restWorld : mat4.multiply(mat4.create(), skeleton.inverseBinds[parent], restWorld);
            return [local[12], local[13], local[14]];
        });
    }

    public update(seconds: number): boolean {
        const index = Math.floor(seconds / this.clip.frameTime) % this.clip.frames.length;
        if (index === this.lastFrame) return false;
        this.lastFrame = index;
        const frame = this.clip.frames[index];
        for (let bone = 0; bone < frame.length; bone++) {
            const key = frame[bone];
            const rotation = quat.normalize(quat.create(), key.rotation);
            const local = mat4.fromRotationTranslation(mat4.create(), rotation, key.translation ?? this.restTranslations[bone]);
            const parent = this.skeleton.parents[bone];
            if (parent < 0) mat4.copy(this.worlds[bone], local);
            else mat4.multiply(this.worlds[bone], this.worlds[parent], local);
        }
        for (let bone = 0; bone < this.mapping.length; bone++) {
            const source = this.mapping[bone];
            mat4.multiply(this.matrices[bone], this.worlds[source], this.skeleton.inverseBinds[source]);
        }
        return true;
    }
}

export interface BoneKey {
    rotation: [number, number, number, number];
    translation: [number, number, number] | null;
}

export interface MotionClip {
    frameTime: number;
    frames: BoneKey[][];
}

export function parseIdleMotion(raw: Uint8Array): MotionClip {
    const blob = raw.subarray(0x10);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const u16 = (o: number) => dv.getUint16(o, false);
    const s16 = (o: number) => dv.getInt16(o, false);
    const u32 = (o: number) => dv.getUint32(o, false);
    const f32 = (o: number) => dv.getFloat32(o, false);
    const align = (n: number) => (n + 15) & ~15;
    const groups = (n: number, perWord: number) => n > 0 ? Math.ceil(n / perWord) * 8 : 0;
    const states = u32(0x28);
    let idle = -1, ticks = 2;
    for (let i = 0; i < u32(0x24); i++) {
        const state = u32(states + i * 4);
        const nameAt = u32(state);
        let end = nameAt;
        while (end < blob.length && blob[end]) end++;
        const name = String.fromCharCode(...blob.subarray(nameAt, end));
        if (name !== 'intro_idle') continue;
        const node = u32(state + 4);
        if (u32(node) !== 0x02010000) throw new Error('Monopoly2008: invalid idle state node');
        const motionNode = u32(node + 0x0c);
        if (u32(motionNode) !== 0x16000001) throw new Error('Monopoly2008: invalid idle motion node');
        idle = u32(motionNode + 0x0c);
        ticks = f32(motionNode + 0x18);
        break;
    }
    if (idle < 0) throw new Error('Monopoly2008: missing intro_idle motion');
    const frameCount = u32(idle + 0x1c);
    const header = align(idle + 0x34);
    if ((u32(idle + 0x24) & 0xffff) !== 0 || !u32(header) || frameCount > 1000)
        throw new Error('Monopoly2008: unsupported idle SKA codec');
    const boneCount = u16(header + 0x1c);
    if (!boneCount || boneCount > 256) throw new Error('Monopoly2008: invalid idle bone count');
    let cursor = align(header + 0xd0 + u16(header + 0x1e));
    const masks = cursor; cursor += groups(s16(header + 0x2e), 8);
    const masks16 = cursor; cursor += groups(s16(header + 0x36), 16);
    const masks8 = cursor; cursor += groups(s16(header + 0x38), 16);
    cursor += groups(s16(header + 0x40), 16) + s16(header + 0x54);
    const sizes = [u32(header + 4), u32(header + 0x18), u32(header + 8), u16(header + 0x24),
        u16(header + 0x26), u32(header + 0x0c), u16(header + 0x20), u16(header + 0x22)];
    const starts = sizes.map((size) => { const start = cursor; cursor += size; return start; });
    const [staticRotations, bases, frameFloats, trans16Data, trans8Data, staticTranslations,
        trans16Base, trans8Base] = starts;
    const frameTable = u16(header + 0x2a) ? cursor : 0;
    const vlc = cursor + u16(header + 0x2a);
    const quaternion = (angles: number[]): BoneKey['rotation'] => {
        const a = -Math.PI * angles[1] / 65536;
        const b = -Math.PI * angles[2] / 65536;
        const c = -Math.PI * angles[0] / 65536;
        const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b), sc = Math.sin(c), cc = Math.cos(c);
        return [ca * sb * cc - sa * cb * sc, ca * sb * sc + sa * cb * cc,
            ca * cb * sc - sa * sb * cc, ca * cb * cc + sa * sb * sc];
    };
    const frames: BoneKey[][] = [];
    for (let frame = 0; frame < frameCount; frame++) {
        const stride = frameTable ? u16(frameTable) : 0;
        const vlcOffset = frameTable && frame ? (stride ? s16(frameTable + frame * 2) + stride * frame : u16(frameTable + frame * 2)) : 0;
        let bit = (vlc + vlcOffset) * 8;
        const bits = (count: number) => {
            let value = 0;
            for (let i = 0; i < count; i++, bit++) value = value * 2 + ((blob[bit >>> 3] >>> (7 - (bit & 7))) & 1);
            return value;
        };
        const code = () => bits([12, 8, 4, 0][bits(2)]);
        let mask = 0, rotationAt = staticRotations, baseAt = bases, staticTranslationAt = staticTranslations;
        const translationMasks = [0, 0];
        const translationBases = [trans8Base, trans16Base];
        const corrections = [trans8Data + s16(header + 0x3c) * frame,
            trans16Data + 2 * s16(header + 0x3a) * frame];
        const keys: BoneKey[] = [];
        for (let bone = 0; bone < boneCount; bone++) {
            const flags = dv.getUint16(header + 0xd0 + bone * 2, true);
            let rotation: BoneKey['rotation'];
            if (flags & 1) {
                rotation = quaternion([u16(rotationAt), u16(rotationAt + 2), u16(rotationAt + 4)]);
                rotationAt += 6;
            } else if (flags & 2) {
                const angles = [u16(baseAt), u16(baseAt + 2), u16(baseAt + 4)];
                const mode = (u32(masks + 4 * (mask >>> 3)) >>> (4 * (mask & 7))) & 15;
                mask++; baseAt += 6;
                const axes = mode === 1 ? [0] : mode === 2 ? [2] : mode === 3 ? [1] : [0, 1, 2];
                for (const axis of axes) angles[axis] -= code() << 4;
                rotation = quaternion(angles);
            } else throw new Error(`Monopoly2008: unsupported idle rotation flags ${flags}`);
            let translation: BoneKey['translation'];
            if (flags & 0x18) {
                const wide = (flags & 0x10) ? 0 : 1;
                const at = translationBases[wide];
                translation = [f32(at), f32(at + 4), f32(at + 8)];
                const index = translationMasks[wide]++;
                const source = wide ? masks16 : masks8;
                const mode = (u32(source + 4 * (index >>> 4)) >>> (2 * (index & 15))) & 3;
                const axes = mode ? [mode - 1] : [0, 1, 2];
                for (const axis of axes) {
                    translation[axis] += (wide ? u16(corrections[wide]) : blob[corrections[wide]]) / 1024;
                    corrections[wide] += wide ? 2 : 1;
                }
                translationBases[wide] += 12;
            } else if (flags & 0x20) translation = null;
            else {
                translation = [f32(staticTranslationAt), f32(staticTranslationAt + 4), f32(staticTranslationAt + 8)];
                staticTranslationAt += 12;
            }
            keys.push({ rotation, translation });
        }
        frames.push(keys);
    }
    if (frames.some((frame) => frame.some((key) =>
        ![...key.rotation, ...(key.translation ?? [])].every(Number.isFinite))))
        throw new Error('Monopoly2008: invalid idle transform');
    return { frameTime: ticks / 59.94, frames };
}
