export interface Npm7Submesh {
    positions: Float32Array;
    normals: Float32Array;
    tangents?: Float32Array;
    binormals?: Float32Array;
    colors?: Float32Array;
    uvs: Float32Array;
    blendUvs?: Float32Array;
    lightmapUvs?: Float32Array;
    indices: Uint32Array;
    materialIndex: number;
    instances?: Float32Array[];
    joints?: Uint8Array;
    weights?: Uint8Array;
}

export interface Npm7Material {
    textures: { name: string, type: number, slot: number }[];
    renderMode?: number;
    shaderType?: number;
    featureFlags?: number;
    alphaTest?: boolean;
    alphaThreshold?: number;
    parallaxScale?: number;
    reflectionStrength?: number;
    specularColor?: [number, number, number];
    specularStrength?: number;
    specularPower?: number;
    blendSpecularColor?: [number, number, number];
    blendSpecularStrength?: number;
    blendSpecularPower?: number;
    diffuseScale?: number;
    diffuseBias?: number;
}

export interface Npm7Mesh {
    format: string;
    transform: number[][];
    pivot: [number, number, number];
    bmin: [number, number, number];
    bmax: [number, number, number];
    materials: Npm7Material[];
    submeshes: Npm7Submesh[];
    skin?: { inverseBinds: Float32Array[], parents: number[] };
}

export function parseNPM7(buf: Uint8Array): Npm7Mesh {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== 'NPM7')
        throw new Error(`Monopoly2008: expected NPM7 mesh, got "${magic}"`);

    const n = buf.length;
    const u16 = (o: number) => dv.getUint16(o, false);
    const u32 = (o: number) => dv.getUint32(o, false);
    const f32 = (o: number) => dv.getFloat32(o, false);

    const skinAt = u32(0xa0);
    let skin: Npm7Mesh['skin'];
    const palettes = new Map<number, Uint8Array>();
    if (skinAt) {
        const count = u16(skinAt);
        const parentAt = u32(skinAt + 8);
        if (!count || count > 256 || skinAt + 0x20 + count * 64 > n || parentAt + count > n)
            throw new Error('Monopoly2008: invalid mesh skeleton');
        const inverseBinds = Array.from({ length: count }, (_, bone) =>
            Float32Array.from({ length: 16 }, (_, i) => f32(skinAt + 0x20 + bone * 64 + i * 4)));
        skin = { inverseBinds, parents: Array.from(buf.subarray(parentAt, parentAt + count), (p) => p === 255 ? -1 : p) };
        const groupCount = u32(0x80), groupTable = u32(0x84);
        for (let group = 0; group < groupCount; group++) {
            const record = groupTable + group * 0x30;
            for (let part = 0; part < u32(record + 0x20); part++) {
                const partAt = u32(record + 0x24) + part * 0x30;
                for (let sub = 0; sub < u32(partAt + 0x20); sub++) {
                    const subAt = u32(partAt + 0x28) + sub * 0x30;
                    const paletteAt = u32(subAt + 0x28);
                    if (paletteAt) {
                        const size = buf[paletteAt];
                        if (paletteAt + size >= n) throw new Error('Monopoly2008: invalid bone palette');
                        palettes.set(u32(subAt + 0x20), buf.subarray(paletteAt + 1, paletteAt + 1 + size));
                    }
                }
            }
        }
    }

    const bmin: [number, number, number] = [f32(0x60), f32(0x64), f32(0x68)];
    const bmax: [number, number, number] = [f32(0x70), f32(0x74), f32(0x78)];
    const pivot: [number, number, number] = [f32(0x50), f32(0x54), f32(0x58)];
    const scale: [number, number, number] = [f32(0x20), f32(0x34), f32(0x48)];
    const floatPos = scale.every((v) => Math.abs(v - 1) < 1e-4);

    const nameCount = u32(0x90);
    const nameTable = u32(0x94);
    const materialCount = u32(0x88);
    const materialTable = u32(0x8c);
    const parameterCount = u32(0x98);
    const parameterTable = u32(0x9c);
    if (parameterTable + parameterCount * 4 > n)
        throw new Error('Monopoly2008: invalid material parameter table');
    const materials: Npm7Material[] = [];
    for (let i = 0; i < materialCount; i++) {
        const descriptor = materialTable + i * 0x10;
        const bindingTable = u32(descriptor);
        const bindingCount = buf[descriptor + 4];
        const textures: Npm7Material['textures'] = [];
        for (let j = 0; j < bindingCount; j++) {
            const binding = bindingTable + j * 8;
            const word = u32(binding);
            const nameIndex = word >>> 16;
            if (nameIndex >= nameCount)
                throw new Error(`Monopoly2008: invalid material texture index ${nameIndex}`);
            const nameOffset = u32(nameTable + nameIndex * 4);
            let end = nameOffset;
            while (end < n && buf[end] !== 0)
                end++;
            if (end === n)
                throw new Error(`Monopoly2008: unterminated material texture name at 0x${nameOffset.toString(16)}`);
            textures.push({ name: String.fromCharCode(...buf.subarray(nameOffset, end)), type: word & 0xffff, slot: u32(binding + 4) });
        }
        const renderMode = buf[descriptor + 0x0f];
        if (renderMode > 2)
            throw new Error(`Monopoly2008: unsupported material render mode ${renderMode}`);
        const shaderType = buf[descriptor + 7];
        const featureFlags = buf[descriptor + 9];
        const alphaTest = buf[descriptor + 6] === 3 && renderMode === 0;
        const parameterIndex = u16(descriptor + 0x0a);
        let alphaThreshold: number | undefined;
        let parallaxScale: number | undefined;
        let reflectionStrength: number | undefined;
        let specularColor: [number, number, number] | undefined;
        let specularStrength: number | undefined;
        let specularPower: number | undefined;
        let blendSpecularColor: [number, number, number] | undefined;
        let blendSpecularStrength: number | undefined;
        let blendSpecularPower: number | undefined;
        let diffuseScale: number | undefined;
        let diffuseBias: number | undefined;
        if (shaderType === 12 && parameterIndex !== 0xffff) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: invalid FOLIAGE material parameter index');
            const parameter = u32(parameterTable + parameterIndex * 4);
            if (parameter + 0x1c > n)
                throw new Error('Monopoly2008: invalid FOLIAGE material parameter');
            specularColor = [f32(parameter + 4), f32(parameter + 8), f32(parameter + 12)];
            specularStrength = f32(parameter + 0x14);
            specularPower = f32(parameter + 0x18);
            if (![...specularColor, specularStrength, specularPower].every(Number.isFinite) || specularStrength < 0 || specularPower < 0)
                throw new Error('Monopoly2008: invalid FOLIAGE specular constants');
        }
        if (shaderType === 10 && parameterIndex !== 0xffff) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: invalid WORLD material parameter index');
            const parameter = u32(parameterTable + parameterIndex * 4);
            if (parameter + 0x24 > n)
                throw new Error('Monopoly2008: invalid WORLD material parameter');
            specularColor = [f32(parameter + 4), f32(parameter + 8), f32(parameter + 12)];
            specularStrength = f32(parameter + 0x14);
            specularPower = f32(parameter + 0x18);
            diffuseScale = f32(parameter + 0x1c);
            diffuseBias = f32(parameter + 0x20);
            if (![...specularColor, specularStrength, specularPower].every(Number.isFinite) || specularStrength < 0 || specularPower < 0)
                throw new Error('Monopoly2008: invalid WORLD specular constants');
            if (!Number.isFinite(diffuseScale) || diffuseScale < 0 || !Number.isFinite(diffuseBias))
                throw new Error('Monopoly2008: invalid WORLD diffuse constants');
        }
        if (shaderType === 10 && textures.some((texture) => texture.slot === 3)) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: missing reflection material parameter');
            const parameter = u32(parameterTable + parameterIndex * 4);
            if (parameter + 0x54 > n)
                throw new Error('Monopoly2008: invalid reflection material parameter');
            reflectionStrength = f32(parameter + 0x50);
            if (!Number.isFinite(reflectionStrength) || reflectionStrength < 0)
                throw new Error('Monopoly2008: invalid reflection strength');
        }
        if (shaderType === 10 && (featureFlags & 128)) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: missing blend material parameter');
            const parameter = u32(parameterTable + parameterIndex * 4);
            if (parameter + 0x3c > n)
                throw new Error('Monopoly2008: invalid blend material parameter');
            blendSpecularColor = [f32(parameter + 0x24), f32(parameter + 0x28), f32(parameter + 0x2c)];
            blendSpecularStrength = f32(parameter + 0x34);
            blendSpecularPower = f32(parameter + 0x38);
            if (![...blendSpecularColor, blendSpecularStrength, blendSpecularPower].every(Number.isFinite) || blendSpecularStrength < 0 || blendSpecularPower < 0)
                throw new Error('Monopoly2008: invalid blend specular constants');
        }
        if (shaderType === 10 && (featureFlags & 8) && parameterIndex !== 0xffff) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: invalid material parameter index');
            const parameter = u32(parameterTable + parameterIndex * 4);
            if (parameter + 0x44 > n)
                throw new Error('Monopoly2008: invalid parallax material parameter');
            parallaxScale = f32(parameter + 0x40);
            if (!Number.isFinite(parallaxScale))
                throw new Error('Monopoly2008: nonfinite parallax material parameter');
        }
        if (alphaTest && parameterIndex !== 0xffff && (shaderType === 10 || shaderType === 12)) {
            if (parameterIndex >= parameterCount)
                throw new Error('Monopoly2008: invalid material parameter index');
            const parameter = u32(parameterTable + parameterIndex * 4);
            const thresholdOffset = shaderType === 12 ? 0x28 : 0x48;
            if (parameter + thresholdOffset + 4 > n)
                throw new Error('Monopoly2008: invalid alpha threshold parameter');
            alphaThreshold = f32(parameter + thresholdOffset);
            if (!Number.isFinite(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 1)
                throw new Error('Monopoly2008: invalid material alpha threshold');
        }
        materials.push({ textures, renderMode, shaderType, featureFlags, alphaTest, alphaThreshold, parallaxScale, reflectionStrength, specularColor, specularStrength, specularPower, blendSpecularColor, blendSpecularStrength, blendSpecularPower, diffuseScale, diffuseBias });
    }

    const geomOffset = u32(0x0c);
    const geometryBlocks = new Set<number>();
    for (let p = geomOffset, guard = 0; guard < 100000 && p + 0x50 <= n && buf[p] === 0x50 && buf[p + 1] === 0x48; guard++) {
        geometryBlocks.add(p);
        const size = u32(p + 0x0c);
        if (size < 0x50)
            break;
        p += size;
    }
    const groupStarts = new Map<number, { entry: number, materialIndex: number, instances?: Float32Array[] }>();
    for (let entry = 0; entry + 0x30 <= geomOffset; entry += 4) {
        if (u32(entry + 0x0c) !== 0x3f800000 || u32(entry + 0x1c) !== 0x3f800000 || !geometryBlocks.has(u32(entry + 0x20)))
            continue;
        const materialIndex = u32(entry + 0x2c) >>> 16;
        if (materialIndex >= materials.length)
            throw new Error(`Monopoly2008: invalid material index ${materialIndex}`);
        groupStarts.set(u32(entry + 0x20), { entry, materialIndex });
    }

    for (let group = 0; group < u32(0x80); group++) {
        const record = u32(0x84) + group * 0x30;
        if (record + 0x30 > geomOffset) throw new Error('Monopoly2008: invalid mesh group');
        for (let part = 0; part < u32(record + 0x20); part++) {
            const node = u32(record + 0x24) + part * 0x40;
            if (node + 0x40 > geomOffset) throw new Error('Monopoly2008: invalid mesh node');
            const packed = u32(node + 0x30);
            const instanceCount = packed >>> 16, prototypeCount = packed & 0xffff;
            if (!instanceCount || !prototypeCount) continue;
            const matrixTable = u32(node + 0x38), materialRefs = u32(node + 0x3c);
            if (matrixTable + instanceCount * 0x40 > geomOffset || materialRefs + prototypeCount * 8 > geomOffset)
                throw new Error('Monopoly2008: invalid instance data');
            const instances = Array.from({ length: instanceCount }, (_, i) =>
                Float32Array.from({ length: 16 }, (_, k) => f32(matrixTable + i * 0x40 + k * 4)));
            for (let i = 0; i < prototypeCount; i++) {
                const ref = materialRefs + i * 8;
                const lodTable = u32(ref), materialIndex = u32(ref + 4) >>> 16;
                if (lodTable + 4 > geomOffset || materialIndex >= materials.length || !geometryBlocks.has(u32(lodTable)))
                    throw new Error('Monopoly2008: invalid instanced material');
                groupStarts.set(u32(lodTable), { entry: -1, materialIndex, instances });
            }
        }
    }

    const submeshes: Npm7Submesh[] = [];
    const seenIndexBuffers = new Map<string, number[]>();
    let p = geomOffset;
    let groupInfo: { entry: number, materialIndex: number, instances?: Float32Array[] } | undefined;
    for (let guard = 0; guard < 100000; guard++) {
        if (p + 0x50 > n || buf[p] !== 0x50 || buf[p + 1] !== 0x48)
            break;
        groupInfo = groupStarts.get(p) ?? groupInfo;
        if (!groupInfo)
            throw new Error(`Monopoly2008: missing material for geometry at 0x${p.toString(16)}`);
        const { entry: groupEntry, materialIndex } = groupInfo;
        const blockSize = u32(p + 0x0c);
        const vcount = u16(p + 0x2c);
        const indexCount = u32(p + 0x28);
        const indexOffset = u32(p + 0x20);
        const sharedVertexOffset = u32(p + 0x14);
        const sourceBlock = sharedVertexOffset ? geomOffset + sharedVertexOffset - 0x30 : p;
        const next = blockSize >= 0x50 ? p + blockSize : n;

        const minVtxBytes = floatPos ? 12 : 6;
        if (sourceBlock < geomOffset || sourceBlock + 0x50 > n || buf[sourceBlock] !== 0x50 || buf[sourceBlock + 1] !== 0x48 || u16(sourceBlock + 0x2c) !== vcount)
            throw new Error(`Monopoly2008: invalid shared vertex buffer at 0x${p.toString(16)}`);
        const stride = buf[sourceBlock + 0x1c];
        if (stride >= minVtxBytes && vcount > 0) {
            const vo = sourceBlock + 0x50;
            const positions = new Float32Array(vcount * 3);
            const normals = new Float32Array(vcount * 3);
            const uvs = new Float32Array(vcount * 2);
            const format = u32(sourceBlock + 0x08);
            const palette = palettes.get(p);
            const joints = (format & 0x20000) && palette ? new Uint8Array(vcount * 4) : undefined;
            const weights = joints ? new Uint8Array(vcount * 4) : undefined;
            const blendUvs = (format & 0x20) ? new Float32Array(vcount * 2) : undefined;
            const lightmapUvs = (format & 0x40) ? new Float32Array(vcount * 2) : undefined;
            const uvOffset = stride - 4 * (1 + (blendUvs ? 1 : 0) + (lightmapUvs ? 1 : 0));
            const kind = format & 0xff;
            const normalOffset = (kind === 0x1a && stride === 20) || (kind === 0x19 && stride === 16) ? -1 :
                floatPos ? ((kind & 0x08) ? 16 : 12) :
                    (kind === 0x11 ? ((format & 0x20000) ? 16 : 8) : kind === 0x19 ? 12 : -1);
            const tangentOffset = normalOffset + 4;
            const hasTangentBasis = normalOffset >= 0 && tangentOffset + 8 <= uvOffset;
            const tangents = hasTangentBasis ? new Float32Array(vcount * 3) : undefined;
            const binormals = hasTangentBasis ? new Float32Array(vcount * 3) : undefined;
            const vertexLit = materials[materialIndex].shaderType === 1;
            const colorOffset = floatPos ? 12 : 8;
            const hasVertexColor = (vertexLit || materials[materialIndex].shaderType === 10) &&
                ((kind & 0x1f) === 0x1a || kind === 0x19) && stride >= colorOffset + 8;
            if (vertexLit && !hasVertexColor && kind !== 0x11)
                throw new Error(`Monopoly2008: unsupported vertex-lit format 0x${format.toString(16)} at 0x${p.toString(16)}`);
            const colors = hasVertexColor ? new Float32Array(vcount * 4) : undefined;
            for (let i = 0; i < vcount; i++) {
                const o = vo + i * stride;
                if (o + minVtxBytes > n)
                    break;
                if (floatPos) {
                    positions[i * 3] = f32(o);
                    positions[i * 3 + 1] = f32(o + 4);
                    positions[i * 3 + 2] = f32(o + 8);
                } else {
                    for (let k = 0; k < 3; k++)
                        positions[i * 3 + k] = pivot[k] + u16(o + k * 2) * scale[k];
                }
                if (joints && weights) for (let k = 0; k < 4; k++) {
                    const paletteIndex = buf[o + 8 + k * 2];
                    const weight = buf[o + 9 + k * 2];
                    if (weight && paletteIndex >= palette!.length)
                        throw new Error('Monopoly2008: bone index outside palette');
                    joints[i * 4 + k] = weight ? palette![paletteIndex] : 0;
                    weights[i * 4 + k] = weight;
                }
                if (uvOffset >= minVtxBytes && o + uvOffset + 4 <= n) {
                    uvs[i * 2] = dv.getInt16(o + uvOffset, false) / 4096;
                    uvs[i * 2 + 1] = dv.getInt16(o + uvOffset + 2, false) / 4096;
                    if (blendUvs && o + uvOffset + 8 <= n) {
                        blendUvs[i * 2] = dv.getInt16(o + uvOffset + 4, false) / 4096;
                        blendUvs[i * 2 + 1] = dv.getInt16(o + uvOffset + 6, false) / 4096;
                    }
                    const lightmapOffset = uvOffset + (blendUvs ? 8 : 4);
                    if (lightmapUvs && o + lightmapOffset + 4 <= n) {
                        lightmapUvs[i * 2] = dv.getInt16(o + lightmapOffset, false) / 4096;
                        lightmapUvs[i * 2 + 1] = dv.getInt16(o + lightmapOffset + 2, false) / 4096;
                    }
                }
                if (normalOffset >= 0 && stride >= normalOffset + 4 && o + normalOffset + 4 <= n) {
                    const packed = u32(o + normalOffset);
                    for (let k = 0; k < 3; k++) {
                        let component = (packed >>> (k * 10)) & 0x3ff;
                        if (component & 0x200)
                            component -= 0x400;
                        normals[i * 3 + k] = Math.max(-1, component / 511);
                    }
                }
                if (colors && o + colorOffset + 4 <= n) {
                    const packed = u32(o + colorOffset);
                    colors[i * 4] = ((packed >>> 16) & 255) / 255;
                    colors[i * 4 + 1] = ((packed >>> 8) & 255) / 255;
                    colors[i * 4 + 2] = (packed & 255) / 255;
                    colors[i * 4 + 3] = (packed >>> 24) / 255;
                }
                if (tangents && binormals && o + tangentOffset + 8 <= n) {
                    for (const [offset, output] of [[tangentOffset, tangents], [tangentOffset + 4, binormals]] as const) {
                        const packed = u32(o + offset);
                        for (let k = 0; k < 3; k++) {
                            let component = (packed >>> (k * 10)) & 0x3ff;
                            if (component & 0x200)
                                component -= 0x400;
                            output[i * 3 + k] = Math.max(-1, component / 511);
                        }
                    }
                }
            }
            // PH index offsets use the geometry base and include a 32-byte header.
            const ix = geomOffset + indexOffset + 0x20;
            if (ix + indexCount * 2 > n)
                throw new Error(`Monopoly2008: index buffer outside NPM7 at 0x${p.toString(16)}`);
            const tris: number[] = [];
            let strip: number[] = [];
            for (let k = 0; k < indexCount; k++) {
                const off = ix + k * 2;
                if (off + 2 > n)
                    break;
                const v = u16(off);
                if (v === 0xFFFF || v >= vcount) {
                    flushStrip(strip, tris);
                    strip = [];
                } else {
                    strip.push(v);
                }
            }
            flushStrip(strip, tris);
            if (tris.length > 0) {
                let withinGroup = true;
                for (let i = 0; groupEntry >= 0 && withinGroup && i < tris.length; i++) for (let axis = 0; axis < 3; axis++) {
                    const value = positions[tris[i] * 3 + axis];
                    if (value < f32(groupEntry + axis * 4) - 0.02 || value > f32(groupEntry + 0x10 + axis * 4) + 0.02) {
                        withinGroup = false;
                        break;
                    }
                }
                if (withinGroup) {
                    let hash = 2166136261;
                    for (let k = ix; k < ix + indexCount * 2; k++)
                        hash = Math.imul(hash ^ buf[k], 16777619);
                    const key = `${sourceBlock}:${materialIndex}:${indexCount}:${hash}`;
                    const previous = seenIndexBuffers.get(key) ?? [];
                    const duplicate = previous.some((other) => {
                        for (let k = 0; k < indexCount * 2; k++)
                            if (buf[ix + k] !== buf[other + k]) return false;
                        return true;
                    });
                    if (!duplicate) {
                        previous.push(ix);
                        seenIndexBuffers.set(key, previous);
                        submeshes.push({ positions, normals, tangents, binormals, colors, uvs, blendUvs, lightmapUvs, indices: Uint32Array.from(tris), materialIndex, instances: groupInfo.instances, joints, weights });
                    }
                }
            }
        }

        if (next <= p)
            break;
        p = next;
    }

    const transform: number[][] = [];
    for (let r = 0; r < 3; r++)
        transform.push([f32(0x20 + (r * 4) * 4), f32(0x20 + (r * 4 + 1) * 4), f32(0x20 + (r * 4 + 2) * 4), f32(0x20 + (r * 4 + 3) * 4)]);

    return { format: magic, transform, pivot, bmin, bmax, materials, submeshes, skin };
}

function flushStrip(strip: number[], out: number[]): void {
    for (let i = 0; i < strip.length - 2; i++) {
        const a = strip[i], b = strip[i + 1], c = strip[i + 2];
        if (a === b || a === c || b === c)
            continue;
        if (i & 1)
            out.push(a, c, b);
        else
            out.push(a, b, c);
    }
}
