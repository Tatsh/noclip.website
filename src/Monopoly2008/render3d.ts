import { mat4, vec3 } from "gl-matrix";

import { DeviceProgram } from "../Program.js";
import * as Viewer from "../viewer.js";
import * as UI from "../ui.js";
import { GfxDevice, GfxBuffer, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxVertexBufferDescriptor, GfxTexture, GfxSampler, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform.js";
import { fillColor, fillMatrix4x3, fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxRenderInstList, GfxRenderInstManager, GfxRendererLayer, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager.js";
import { CameraController, computeViewSpaceDepthFromWorldSpacePoint } from "../Camera.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary.js";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers.js";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { colorNewFromRGBA } from "../Color.js";
import { FakeTextureHolder, TextureMapping } from "../TextureHolder.js";
import { AABB } from "../Geometry.js";
import type { Npm7Mesh } from "./npm7.js";
import type { DecodedTexture } from "./xmap.js";
import type { RoomLighting } from "./lighting.js";
import type { SkinPose } from './motion.js';

export interface MonopolyMesh {
    name: string;
    mesh: Npm7Mesh;
    instances?: mat4[];
    skinPose?: SkinPose;
}

export interface MonopolyTexture {
    name: string;
    tex: DecodedTexture;
}

class MeshProgram extends DeviceProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_TexCoord = 2;
    public static a_LightmapCoord = 3;
    public static a_Tangent = 4;
    public static a_Binormal = 5;
    public static a_Color = 6;
    public static a_BlendTexCoord = 7;

    public static ub_SceneParams = 0;
    public static ub_ObjectParams = 1;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat3x4 u_View;
    vec4 u_Ambient;
    vec4 u_LightDirection[3];
    vec4 u_LightColor[3];
};

layout(std140) uniform ub_ObjectParams {
    Mat3x4 u_Model;
    vec4 u_Color;
    vec4 u_MaterialFlags;
    vec4 u_AlphaParams;
    vec4 u_EyePosition;
    vec4 u_ReflectionParams;
    vec4 u_SpecularParams;
    vec4 u_WorldParams;
    vec4 u_BlendSpecular;
};

varying vec3 v_LightColor;
varying vec3 v_Normal;
varying vec3 v_Tangent;
varying vec3 v_Binormal;
varying vec3 v_EyeVector;
varying vec4 v_Color;
varying vec2 v_TexCoord;
varying vec2 v_BlendTexCoord;
varying vec2 v_LightmapCoord;

#ifdef VERT
layout(location = ${MeshProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${MeshProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${MeshProgram.a_TexCoord}) attribute vec2 a_TexCoord;
layout(location = ${MeshProgram.a_LightmapCoord}) attribute vec2 a_LightmapCoord;
layout(location = ${MeshProgram.a_Tangent}) attribute vec3 a_Tangent;
layout(location = ${MeshProgram.a_Binormal}) attribute vec3 a_Binormal;
layout(location = ${MeshProgram.a_Color}) attribute vec4 a_Color;
layout(location = ${MeshProgram.a_BlendTexCoord}) attribute vec2 a_BlendTexCoord;

void mainVS() {
    vec3 t_PositionWorld = UnpackMatrix(u_Model) * vec4(a_Position, 1.0);
    vec3 t_PositionView = UnpackMatrix(u_View) * vec4(t_PositionWorld, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * vec4(t_PositionView, 1.0);
    vec3 t_NormalWorld = normalize(UnpackMatrix(u_Model) * vec4(a_Normal, 0.0));
    v_Normal = t_NormalWorld;
    v_Tangent = normalize(UnpackMatrix(u_Model) * vec4(a_Tangent, 0.0));
    v_Binormal = normalize(UnpackMatrix(u_Model) * vec4(a_Binormal, 0.0));
    v_EyeVector = u_EyePosition.xyz - t_PositionWorld;
    v_LightColor = u_Ambient.rgb;
    for (int i = 0; i < 3; i++)
        v_LightColor += u_LightColor[i].rgb * u_LightDirection[i].w * max(dot(t_NormalWorld, u_LightDirection[i].xyz), 0.0);
    // shortcut: DefaultColor, ColorBlend, and ColorModulate uploads are unmapped.
    v_Color = u_MaterialFlags.w > 0.5 ? a_Color : vec4(v_LightColor, 1.0);
    v_TexCoord = a_TexCoord;
    v_BlendTexCoord = a_BlendTexCoord;
    v_LightmapCoord = a_LightmapCoord;
}
#endif

#ifdef FRAG
uniform sampler2D u_Texture;
uniform sampler2D u_Lightmap;
uniform sampler2D u_NormalMap;
uniform sampler2D u_BlendTexture;
uniform sampler2D u_ReflectionTexture;
uniform sampler2D u_MaskTexture;
void mainPS() {
    if (u_MaterialFlags.y > 0.5) {
        vec4 t_VertexLit = texture(u_Texture, v_TexCoord) * v_Color;
        if (u_MaterialFlags.z > 0.5 && t_VertexLit.a < u_AlphaParams.x) discard;
        gl_FragColor = vec4(2.0 * t_VertexLit.rgb, t_VertexLit.a);
        return;
    }
    vec2 t_UV = v_TexCoord;
    if (u_MaterialFlags.x > 0.5 && abs(u_AlphaParams.w) > 0.000001) {
        float t_Height = texture(u_NormalMap, t_UV).b * u_AlphaParams.w;
        vec3 t_Eye = normalize(v_EyeVector);
        t_UV += t_Height * vec2(dot(t_Eye, v_Tangent), -dot(t_Eye, v_Binormal));
    }
    vec3 t_Shade = u_Color.a > 1.5 ? texture(u_Lightmap, v_LightmapCoord).rgb + u_Ambient.rgb : v_LightColor;
    // shortcut: Lightmap bump blend and specular terms await XEX shader mapping.
    vec3 t_Normal = normalize(v_Normal);
    if (u_MaterialFlags.x > 0.5) {
        vec2 t_NormalXY = texture(u_NormalMap, t_UV).gr * 2.0 - 1.0;
        t_Normal = normalize(v_Tangent * t_NormalXY.x + v_Binormal * t_NormalXY.y + v_Normal * sqrt(max(1.0 - dot(t_NormalXY, t_NormalXY), 0.0)));
    }
    if (u_MaterialFlags.x > 0.5 && u_Color.a < 1.5) {
        t_Shade = u_Ambient.rgb;
        for (int i = 0; i < 3; i++) {
            float t_Lit = clamp((dot(t_Normal, u_LightDirection[i].xyz) + u_WorldParams.y) * u_WorldParams.x, 0.0, 1.0);
            t_Shade += t_Lit * u_LightColor[i].rgb * u_LightDirection[i].w;
        }
    }
    vec4 t_Base = u_Color.a > 0.5 ? texture(u_Texture, t_UV) : vec4(u_Color.rgb, 1.0);
    float t_BlendFactor = 0.0;
    if (u_AlphaParams.y > 0.5) {
        vec4 t_Blend = texture(u_BlendTexture, v_BlendTexCoord);
        t_BlendFactor = v_Color.a * t_Blend.a;
        t_Base.rgb = mix(t_Base.rgb, t_Blend.rgb, t_BlendFactor);
    }
    if (u_MaterialFlags.z > 0.5 && t_Base.a < u_AlphaParams.x) discard;
    if (u_Color.a < 1.5 && u_MaterialFlags.x < 0.5)
        t_Shade = u_Ambient.rgb + (t_Shade - u_Ambient.rgb) * u_WorldParams.x;
    if (u_MaterialFlags.w > 0.5)
        t_Shade = u_MaterialFlags.x > 0.5 ? u_Ambient.rgb + (t_Shade - u_Ambient.rgb) * v_Color.rgb : u_Ambient.rgb + v_Color.rgb;
    vec3 t_RGB = t_Base.rgb * t_Shade * (u_Color.a > 1.5 ? 1.0 : 2.0);
    vec3 t_Mask = u_ReflectionParams.z > 0.5 ? texture(u_MaskTexture, t_UV).rgb : vec3(0.0, 1.0, 1.0);
    t_RGB *= mix(t_Mask.b, 1.0, t_BlendFactor);
    if (max(u_SpecularParams.w, u_BlendSpecular.w) > 0.0) {
        vec3 t_ViewDirection = normalize(v_EyeVector);
        vec3 t_Specular = vec3(0.0);
        float t_SpecularPower = mix(u_ReflectionParams.w, u_WorldParams.z, t_BlendFactor);
        // shortcut: The fourth light and Fresnel factor await XEX parameter mapping.
        for (int i = 0; i < 3; i++) {
            if (u_LightDirection[i].w <= 0.0) continue;
            vec3 t_LightDirection = normalize(u_LightDirection[i].xyz);
            vec3 t_Half = normalize(t_ViewDirection + t_LightDirection);
            float t_DiffuseGate = min(10.0 * max(dot(t_Normal, t_LightDirection), 0.0), 1.0);
            float t_Highlight = pow(max(dot(t_Normal, t_Half), 0.0), mix(t_Mask.g, 1.0, t_BlendFactor) * t_SpecularPower);
            t_Specular += u_LightColor[i].rgb * u_LightDirection[i].w * t_DiffuseGate * t_Highlight;
        }
        t_RGB += t_Specular * mix(u_SpecularParams.rgb, u_BlendSpecular.rgb, t_BlendFactor) * mix(u_SpecularParams.w, u_BlendSpecular.w, t_BlendFactor) * (u_ReflectionParams.z > 0.5 ? t_Mask.r * t_Mask.b : 1.0);
    }
    float t_Alpha = u_AlphaParams.z > 0.5 ? t_Base.a * (u_MaterialFlags.w > 0.5 ? v_Color.a : 1.0) : 1.0;
    if (u_ReflectionParams.x > 0.0) {
        vec3 t_Reflected = reflect(-normalize(v_EyeVector), t_Normal);
        // shortcut: Reflection uses view rotation until XEX TextureMatrix upload is mapped.
        vec3 t_ReflectedView = UnpackMatrix(u_View) * vec4(t_Reflected, 0.0);
        vec2 t_ReflectionUV = vec2(0.5) + t_ReflectedView.xy * vec2(0.5, -0.5);
        vec4 t_Reflection = texture(u_ReflectionTexture, t_ReflectionUV);
        float t_ReflectionWeight = u_ReflectionParams.x * (u_ReflectionParams.z > 0.5 ? t_Mask.r * t_Mask.b : 1.0);
        t_RGB += t_Reflection.rgb * t_Reflection.a * t_ReflectionWeight;
        if (u_ReflectionParams.y > 0.5)
            t_Alpha += t_Reflection.a * t_ReflectionWeight;
    }
    gl_FragColor = vec4(t_RGB, t_Alpha);
}
#endif
`;
}

class Submesh {
    public numVertices: number;
    private center = vec3.create();
    private worldCenter = vec3.create();
    private bounds: AABB;
    private worldBounds = new AABB();
    private posBuffer: GfxBuffer;
    private nrmBuffer: GfxBuffer;
    private uvBuffer: GfxBuffer;
    private lightmapUvBuffer: GfxBuffer;
    private tangentBuffer: GfxBuffer;
    private binormalBuffer: GfxBuffer;
    private colorBuffer: GfxBuffer;
    private blendUvBuffer: GfxBuffer;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    private textureMapping = [new TextureMapping(), new TextureMapping(), new TextureMapping(), new TextureMapping(), new TextureMapping(), new TextureMapping()];
    private skinJoints?: Uint8Array;
    private skinWeights?: Uint8Array;
    private basePositions?: Float32Array;
    private baseNormals?: Float32Array;
    private baseTangents?: Float32Array;
    private baseBinormals?: Float32Array;
    public instances?: mat4[];

    constructor(device: GfxDevice, positions: Float32Array, normals: Float32Array, tangents: Float32Array | undefined, binormals: Float32Array | undefined, colors: Float32Array | undefined, uvs: Float32Array, blendUvs: Float32Array | undefined, lightmapUvs: Float32Array | undefined, indices: Uint32Array, joints: Uint8Array | undefined, weights: Uint8Array | undefined, private inputLayout: GfxInputLayout, texture: GfxTexture | undefined, lightmap: GfxTexture | undefined, normalMap: GfxTexture | undefined, blendTexture: GfxTexture | undefined, reflectionTexture: GfxTexture | undefined, maskTexture: GfxTexture | undefined, sampler: GfxSampler, private renderMode: number, vertexLit: boolean, private alphaTest: boolean, private alphaThreshold: number, private vertexAlpha: boolean, private parallaxScale: number, private reflectionStrength: number, private reflectionAddsAlpha: boolean, private specularColor: [number, number, number], private specularStrength: number, private specularPower: number, private blendSpecularColor: [number, number, number], private blendSpecularStrength: number, private blendSpecularPower: number, private diffuseScale: number, private diffuseBias: number, instances?: Float32Array[]) {
        this.instances = instances as mat4[] | undefined;
        const n = indices.length;
        const posData = new Float32Array(n * 3);
        const nrmData = new Float32Array(n * 3);
        const uvData = new Float32Array(n * 2);
        const blendUvData = new Float32Array(n * 2);
        const lightmapUvData = new Float32Array(n * 2);
        const tangentData = new Float32Array(n * 3);
        const binormalData = new Float32Array(n * 3);
        const colorData = new Float32Array(n * 4);
        if (joints && weights) {
            this.skinJoints = new Uint8Array(n * 4);
            this.skinWeights = new Uint8Array(n * 4);
            for (let i = 0; i < n; i++) {
                this.skinJoints.set(joints.subarray(indices[i] * 4, indices[i] * 4 + 4), i * 4);
                this.skinWeights.set(weights.subarray(indices[i] * 4, indices[i] * 4 + 4), i * 4);
            }
        }
        const t = vec3.create();
        const min = vec3.fromValues(Infinity, Infinity, Infinity);
        const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < n; i += 3) {
            const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
            const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
            vec3.min(min, min, [ax, ay, az]); vec3.min(min, min, [bx, by, bz]); vec3.min(min, min, [cx, cy, cz]);
            vec3.max(max, max, [ax, ay, az]); vec3.max(max, max, [bx, by, bz]); vec3.max(max, max, [cx, cy, cz]);
            vec3.cross(t, [ax - bx, ay - by, az - bz], [ax - cx, ay - cy, az - cz]);
            vec3.normalize(t, t);
            const o = i * 3;
            posData[o] = ax; posData[o + 1] = ay; posData[o + 2] = az;
            posData[o + 3] = bx; posData[o + 4] = by; posData[o + 5] = bz;
            posData[o + 6] = cx; posData[o + 7] = cy; posData[o + 8] = cz;
            uvData[i * 2] = uvs[i0 * 2]; uvData[i * 2 + 1] = uvs[i0 * 2 + 1];
            uvData[i * 2 + 2] = uvs[i1 * 2]; uvData[i * 2 + 3] = uvs[i1 * 2 + 1];
            uvData[i * 2 + 4] = uvs[i2 * 2]; uvData[i * 2 + 5] = uvs[i2 * 2 + 1];
            if (blendUvs) for (let k = 0; k < 3; k++) {
                const source = indices[i + k] * 2;
                blendUvData[i * 2 + k * 2] = blendUvs[source];
                blendUvData[i * 2 + k * 2 + 1] = blendUvs[source + 1];
            }
            if (lightmapUvs) for (let k = 0; k < 3; k++) {
                const source = indices[i + k] * 2;
                lightmapUvData[i * 2 + k * 2] = lightmapUvs[source];
                lightmapUvData[i * 2 + k * 2 + 1] = lightmapUvs[source + 1];
            }
            if (tangents && binormals) for (let k = 0; k < 3; k++) {
                const source = indices[i + k] * 3;
                tangentData.set(tangents.subarray(source, source + 3), o + k * 3);
                binormalData.set(binormals.subarray(source, source + 3), o + k * 3);
            }
            for (let k = 0; k < 3; k++) {
                const source = indices[i + k] * 4;
                colorData.set(colors ? colors.subarray(source, source + 4) : [1, 1, 1, 1], (i + k) * 4);
            }
            for (let k = 0; k < 3; k++) {
                const source = indices[i + k] * 3;
                const lengthSq = normals[source] ** 2 + normals[source + 1] ** 2 + normals[source + 2] ** 2;
                nrmData[o + k * 3] = lengthSq > 0.01 ? normals[source] : t[0];
                nrmData[o + k * 3 + 1] = lengthSq > 0.01 ? normals[source + 1] : t[1];
                nrmData[o + k * 3 + 2] = lengthSq > 0.01 ? normals[source + 2] : t[2];
            }
        }
        const frequency = this.skinJoints ? GfxBufferFrequencyHint.Dynamic : GfxBufferFrequencyHint.Static;
        this.posBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, frequency, posData.buffer);
        this.nrmBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, frequency, nrmData.buffer);
        this.uvBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, uvData.buffer);
        this.blendUvBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, blendUvData.buffer);
        this.lightmapUvBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, lightmapUvData.buffer);
        this.tangentBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, frequency, tangentData.buffer);
        this.binormalBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, frequency, binormalData.buffer);
        this.colorBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, colorData.buffer);
        this.vertexBufferDescriptors = [{ buffer: this.posBuffer }, { buffer: this.nrmBuffer }, { buffer: this.uvBuffer }, { buffer: this.lightmapUvBuffer }, { buffer: this.tangentBuffer }, { buffer: this.binormalBuffer }, { buffer: this.colorBuffer }, { buffer: this.blendUvBuffer }];
        this.textureMapping[0].gfxTexture = texture ?? null;
        this.textureMapping[0].gfxSampler = sampler;
        this.textureMapping[1].gfxTexture = lightmap ?? texture ?? null;
        this.textureMapping[1].gfxSampler = sampler;
        this.textureMapping[2].gfxTexture = normalMap ?? texture ?? null;
        this.textureMapping[2].gfxSampler = sampler;
        this.textureMapping[3].gfxTexture = blendTexture ?? texture ?? null;
        this.textureMapping[3].gfxSampler = sampler;
        this.textureMapping[4].gfxTexture = reflectionTexture ?? texture ?? null;
        this.textureMapping[4].gfxSampler = sampler;
        this.textureMapping[5].gfxTexture = maskTexture ?? texture ?? null;
        this.textureMapping[5].gfxSampler = sampler;
        this.hasMask = !!maskTexture;
        this.hasLightmap = !!(lightmap && lightmapUvs);
        this.hasNormalMap = !!(normalMap && tangents && binormals);
        this.hasBlend = !!(blendTexture && blendUvs);
        this.hasVertexColors = !!colors;
        this.vertexLit = vertexLit;
        this.numVertices = n;
        if (this.skinJoints) {
            this.basePositions = posData;
            this.baseNormals = nrmData;
            this.baseTangents = tangentData;
            this.baseBinormals = binormalData;
        }
        vec3.scale(this.center, vec3.add(this.center, min, max), 0.5);
        this.bounds = new AABB(min[0], min[1], min[2], max[0], max[1], max[2]);
    }

    private hasLightmap: boolean;
    private hasNormalMap: boolean;
    private hasBlend: boolean;
    private hasMask: boolean;
    private vertexLit: boolean;
    private hasVertexColors: boolean;

    public updateSkin(device: GfxDevice, matrices: mat4[]): void {
        if (!this.skinJoints || !this.skinWeights) return;
        const transform = (source: Float32Array, point: boolean) => {
            const out = new Float32Array(source.length);
            for (let i = 0; i < this.numVertices; i++) {
                const o = i * 3, x = source[o], y = source[o + 1], z = source[o + 2];
                let px = 0, py = 0, pz = 0;
                for (let k = 0; k < 4; k++) {
                    const weight = this.skinWeights![i * 4 + k] / 255;
                    if (!weight) continue;
                    const m = matrices[this.skinJoints![i * 4 + k]];
                    px += weight * (m[0] * x + m[4] * y + m[8] * z + (point ? m[12] : 0));
                    py += weight * (m[1] * x + m[5] * y + m[9] * z + (point ? m[13] : 0));
                    pz += weight * (m[2] * x + m[6] * y + m[10] * z + (point ? m[14] : 0));
                }
                if (!point) {
                    const length = Math.hypot(px, py, pz) || 1;
                    px /= length; py /= length; pz /= length;
                }
                out[o] = px; out[o + 1] = py; out[o + 2] = pz;
            }
            return new Uint8Array(out.buffer);
        };
        const positions = transform(this.basePositions!, true);
        const skinned = new Float32Array(positions.buffer);
        this.bounds.reset();
        for (let i = 0; i < skinned.length; i += 3) {
            for (let axis = 0; axis < 3; axis++) {
                this.bounds.min[axis] = Math.min(this.bounds.min[axis], skinned[i + axis]);
                this.bounds.max[axis] = Math.max(this.bounds.max[axis], skinned[i + axis]);
            }
        }
        if (![...this.bounds.min, ...this.bounds.max].every(Number.isFinite))
            throw new Error('Monopoly2008: invalid skinned mesh bounds');
        vec3.scale(this.center, vec3.add(this.center, this.bounds.min, this.bounds.max), 0.5);
        device.uploadBufferData(this.posBuffer, 0, positions);
        device.uploadBufferData(this.nrmBuffer, 0, transform(this.baseNormals!, false));
        if (this.hasNormalMap) {
            device.uploadBufferData(this.tangentBuffer, 0, transform(this.baseTangents!, false));
            device.uploadBufferData(this.binormalBuffer, 0, transform(this.baseBinormals!, false));
        }
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, model: mat4, viewerInput: Viewer.ViewerRenderInput): void {
        if (this.numVertices === 0)
            return;
        this.worldBounds.transform(this.bounds, model);
        if (!viewerInput.camera.frustum.contains(this.worldBounds))
            return;
        const renderInst = renderInstManager.newRenderInst();
        renderInst.sortKey = makeSortKey(this.renderMode === 0 ? GfxRendererLayer.OPAQUE : GfxRendererLayer.TRANSLUCENT);
        if (this.renderMode !== 0) {
            vec3.transformMat4(this.worldCenter, this.center, model);
            renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, computeViewSpaceDepthFromWorldSpacePoint(viewerInput.camera.viewMatrix, this.worldCenter));
        }
        if (this.renderMode === 0) {
            const state = renderInst.setMegaStateFlags({});
            setAttachmentStateSimple(state, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.One, blendDstFactor: GfxBlendFactor.Zero });
        } else {
            const state = renderInst.setMegaStateFlags({ depthWrite: false });
            if (this.renderMode === 1)
                setAttachmentStateSimple(state, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: GfxBlendFactor.One });
            else
                setAttachmentStateSimple(state, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha });
        }
        renderInst.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, null);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
        let offs = renderInst.allocateUniformBuffer(MeshProgram.ub_ObjectParams, 44);
        const d = renderInst.mapUniformBufferF32(MeshProgram.ub_ObjectParams);
        offs += fillMatrix4x3(d, offs, model);
        offs += fillColor(d, offs, colorNewFromRGBA(0.78, 0.78, 0.80, this.textureMapping[0].gfxTexture ? (this.hasLightmap ? 2 : 1) : 0));
        d[offs] = this.hasNormalMap ? 1 : 0;
        d[offs + 1] = this.vertexLit ? 1 : 0;
        d[offs + 2] = this.alphaTest ? 1 : 0;
        d[offs + 3] = this.hasVertexColors ? 1 : 0;
        d[offs + 4] = this.alphaThreshold;
        d[offs + 5] = this.hasBlend ? 1 : 0;
        d[offs + 6] = this.vertexAlpha ? 1 : 0;
        d[offs + 7] = this.parallaxScale;
        d[offs + 8] = viewerInput.camera.worldMatrix[12];
        d[offs + 9] = viewerInput.camera.worldMatrix[13];
        d[offs + 10] = viewerInput.camera.worldMatrix[14];
        d[offs + 12] = this.reflectionStrength;
        d[offs + 13] = this.reflectionAddsAlpha ? 1 : 0;
        d[offs + 14] = this.hasMask ? 1 : 0;
        d[offs + 15] = this.specularPower;
        d.set([...this.specularColor, this.specularStrength], offs + 16);
        d[offs + 20] = this.diffuseScale;
        d[offs + 21] = this.diffuseBias;
        d[offs + 22] = this.blendSpecularPower;
        d.set([...this.blendSpecularColor, this.blendSpecularStrength], offs + 24);
        renderInst.setDrawCount(this.numVertices);
        renderInstManager.submitRenderInst(renderInst);
    }

    public setTexture(slot: number, texture: GfxTexture | undefined): void {
        this.textureMapping[slot].gfxTexture = texture ?? null;
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.posBuffer);
        device.destroyBuffer(this.nrmBuffer);
        device.destroyBuffer(this.uvBuffer);
        device.destroyBuffer(this.blendUvBuffer);
        device.destroyBuffer(this.lightmapUvBuffer);
        device.destroyBuffer(this.tangentBuffer);
        device.destroyBuffer(this.binormalBuffer);
        device.destroyBuffer(this.colorBuffer);
    }
}

class MeshRenderer {
    public visible = true;
    public name: string;
    private submeshes: Submesh[] = [];
    private textureNames: (string | undefined)[][] = [];
    private instances: mat4[];
    private skinPose?: SkinPose;
    constructor(private device: GfxDevice, m: MonopolyMesh, inputLayout: GfxInputLayout, textures: Map<string, GfxTexture>, sampler: GfxSampler) {
        this.name = m.name;
        this.instances = m.instances ?? [mat4.create()];
        this.skinPose = m.skinPose;
        for (const sm of m.mesh.submeshes) {
            const diffuse = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 0);
            const lightmap = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 4);
            const normalMap = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 1);
            const blendTexture = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 5);
            const reflectionTexture = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 3);
            const maskTexture = m.mesh.materials[sm.materialIndex].textures.find((t) => t.slot === 2);
            if (reflectionTexture && !textures.has(reflectionTexture.name))
                throw new Error(`Monopoly2008: missing reflection texture ${reflectionTexture.name} for ${m.name}`);
            if (maskTexture && !textures.has(maskTexture.name))
                throw new Error(`Monopoly2008: missing mask texture ${maskTexture.name} for ${m.name}`);
            const renderMode = m.mesh.materials[sm.materialIndex].renderMode ?? 0;
            const vertexLit = m.mesh.materials[sm.materialIndex].shaderType === 1;
            const alphaTest = m.mesh.materials[sm.materialIndex].alphaTest ?? false;
            const alphaThreshold = m.mesh.materials[sm.materialIndex].alphaThreshold ?? 0.004;
            const flags = m.mesh.materials[sm.materialIndex].featureFlags;
            const reflectionSupported = m.mesh.materials[sm.materialIndex].shaderType === 10 && !!reflectionTexture;
            if (sm.indices.length >= 3) {
                this.submeshes.push(new Submesh(device, sm.positions, sm.normals, sm.tangents, sm.binormals, sm.colors, sm.uvs, sm.blendUvs, sm.lightmapUvs, sm.indices, sm.joints, sm.weights, inputLayout, textures.get(diffuse?.name ?? ''), textures.get(lightmap?.name ?? ''), textures.get(normalMap?.name ?? ''), textures.get(blendTexture?.name ?? ''), textures.get(reflectionTexture?.name ?? ''), ((flags ?? 0) & 16) !== 0 ? textures.get(maskTexture?.name ?? '') : undefined, sampler,
                    renderMode, vertexLit, alphaTest, alphaThreshold, !!((flags ?? 0) & 4), m.mesh.materials[sm.materialIndex].parallaxScale ?? 0, reflectionSupported ? m.mesh.materials[sm.materialIndex].reflectionStrength ?? 0 : 0, reflectionSupported && renderMode === 2 && !!((flags ?? 0) & 4), m.mesh.materials[sm.materialIndex].specularColor ?? [0, 0, 0], m.mesh.materials[sm.materialIndex].specularStrength ?? 0, m.mesh.materials[sm.materialIndex].specularPower ?? 0, m.mesh.materials[sm.materialIndex].blendSpecularColor ?? m.mesh.materials[sm.materialIndex].specularColor ?? [0, 0, 0], m.mesh.materials[sm.materialIndex].blendSpecularStrength ?? m.mesh.materials[sm.materialIndex].specularStrength ?? 0, m.mesh.materials[sm.materialIndex].blendSpecularPower ?? m.mesh.materials[sm.materialIndex].specularPower ?? 0, m.mesh.materials[sm.materialIndex].diffuseScale ?? 1, m.mesh.materials[sm.materialIndex].diffuseBias ?? 0, sm.instances));
                this.textureNames.push([diffuse?.name, lightmap?.name, normalMap?.name, blendTexture?.name, reflectionTexture?.name, maskTexture?.name]);
            }
        }
    }

    public setLocale(locale: string, textures: Map<string, GfxTexture>): void {
        for (let i = 0; i < this.submeshes.length; i++)
            this.textureNames[i].forEach((name, slot) => {
                if (name) this.submeshes[i].setTexture(slot, textures.get(`${name}@${locale}`) ?? textures.get(name));
            });
    }

    public setVisible(v: boolean): void { this.visible = v; }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible)
            return;
        if (this.skinPose?.update(viewerInput.time / 1000))
            for (const sm of this.submeshes) sm.updateSkin(this.device, this.skinPose.matrices);
        const model = mat4.create();
        for (const instance of this.instances) {
            for (const sm of this.submeshes) {
                if (sm.instances) for (const local of sm.instances)
                    sm.prepareToRender(renderInstManager, mat4.multiply(model, instance, local), viewerInput);
                else sm.prepareToRender(renderInstManager, instance, viewerInput);
            }
        }
    }

    public destroy(device: GfxDevice): void {
        for (const sm of this.submeshes)
            sm.destroy(device);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 6 },
];
const LANGUAGE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/></svg>';

export class MonopolyScene3D implements Viewer.SceneGfx {
    public textureHolder: FakeTextureHolder;
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private meshRenderers: MeshRenderer[] = [];
    private gfxTextures: GfxTexture[] = [];
    private textureByName = new Map<string, GfxTexture>();
    private cameraCenter = vec3.create();
    private cameraRadius = 1;
    private lighting: RoomLighting;

    constructor(device: GfxDevice, meshes: MonopolyMesh[], textures: MonopolyTexture[], focusMesh: string, lighting: RoomLighting | undefined, private localeChoices: readonly (readonly [string, string])[], private initialLocaleIndex = 0) {
        this.lighting = lighting ?? { ambient: [0.35, 0.35, 0.35], lights: [{ direction: [-0.2 / Math.sqrt(1.29), 1 / Math.sqrt(1.29), -0.5 / Math.sqrt(1.29)], color: [1, 1, 1], intensity: 0.65 }] };
        this.renderHelper = new GfxRenderHelper(device);
        this.program = this.renderHelper.renderCache.createProgram(new MeshProgram());

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: MeshProgram.a_Position, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: MeshProgram.a_Normal, bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: MeshProgram.a_TexCoord, bufferIndex: 2, bufferByteOffset: 0, format: GfxFormat.F32_RG },
            { location: MeshProgram.a_LightmapCoord, bufferIndex: 3, bufferByteOffset: 0, format: GfxFormat.F32_RG },
            { location: MeshProgram.a_Tangent, bufferIndex: 4, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: MeshProgram.a_Binormal, bufferIndex: 5, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: MeshProgram.a_Color, bufferIndex: 6, bufferByteOffset: 0, format: GfxFormat.F32_RGBA },
            { location: MeshProgram.a_BlendTexCoord, bufferIndex: 7, bufferByteOffset: 0, format: GfxFormat.F32_RG },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 2 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 2 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 4 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 2 * 0x04, frequency: GfxVertexBufferFrequency.PerVertex },
        ];
        this.inputLayout = this.renderHelper.renderCache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat: null });

        if (meshes.length > 0) {
            const min = vec3.fromValues(Infinity, Infinity, Infinity);
            const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            const framedMeshes = focusMesh ? meshes.filter((m) => m.name === focusMesh) : meshes;
            for (const { mesh } of framedMeshes.length ? framedMeshes : meshes) {
                vec3.min(min, min, mesh.bmin);
                vec3.max(max, max, mesh.bmax);
            }
            vec3.scale(this.cameraCenter, vec3.add(this.cameraCenter, min, max), 0.5);
            this.cameraRadius = vec3.distance(min, max);
        }

        const viewerTextures: Viewer.Texture[] = [];
        for (const t of textures) {
            const levels = t.tex.mips ?? [t.tex.rgba];
            const gfxTex = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, t.tex.width, t.tex.height, levels.length));
            device.setResourceName(gfxTex, t.name);
            levels.forEach((rgba, level) => device.uploadTextureData(gfxTex, level, [rgba]));
            this.gfxTextures.push(gfxTex);
            if (!this.textureByName.has(t.name))
                this.textureByName.set(t.name, gfxTex);
            const extraInfo = new Map<string, string>();
            extraInfo.set("Size", `${t.tex.width}x${t.tex.height}`);
            viewerTextures.push({ gfxTexture: gfxTex, extraInfo });
        }
        viewerTextures.sort((a, b) => (a.gfxTexture.ResourceName ?? "").localeCompare(b.gfxTexture.ResourceName ?? ""));
        this.textureHolder = new FakeTextureHolder(viewerTextures);
        // shortcut: Sampler settings await XEX mapping; trilinear filtering uses authored mipmaps.
        const sampler = this.renderHelper.renderCache.createSampler({ minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear, mipFilter: GfxMipFilterMode.Linear, minLOD: 0, maxLOD: 16, wrapS: GfxWrapMode.Repeat, wrapT: GfxWrapMode.Repeat });
        this.meshRenderers = meshes.map((m) => new MeshRenderer(device, m, this.inputLayout, this.textureByName, sampler));
        this.switchLocale(this.initialLocaleIndex);
    }

    private switchLocale(index: number): void {
        const locale = this.localeChoices[index][0];
        for (const renderer of this.meshRenderers) {
            if (renderer.name.startsWith('wm_board_')) renderer.setLocale(locale, this.textureByName);
            if (renderer.name.startsWith('Board names and prices@')) renderer.setVisible(renderer.name.endsWith(`@${locale}`));
        }
    }

    public adjustCameraController(c: CameraController): void {
        c.setSceneMoveSpeedMult(1 / 60);
    }

    public getDefaultWorldMatrix(dst: mat4): void {
        const [x, y, z] = this.cameraCenter;
        const r = this.cameraRadius;
        mat4.targetTo(dst, [x + r * 0.4, y + r * 0.7, z + r * 0.7], this.cameraCenter, [0, 1, 0]);
    }

    private prepareToRender(viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.program);
        const state = template.setMegaStateFlags({ cullMode: GfxCullMode.Back, frontFace: GfxFrontFaceMode.CW });
        setAttachmentStateSimple(state, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha });

        let offs = template.allocateUniformBuffer(MeshProgram.ub_SceneParams, 56);
        const mapped = template.mapUniformBufferF32(MeshProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x3(mapped, offs, viewerInput.camera.viewMatrix);
        mapped.set([...this.lighting.ambient, 1], offs); offs += 4;
        for (let i = 0; i < 3; i++) {
            const light = this.lighting.lights[i];
            mapped.set(light ? [...light.direction, light.intensity] : [0, 0, 0, 0], offs);
            offs += 4;
        }
        for (let i = 0; i < 3; i++) {
            mapped.set(this.lighting.lights[i]?.color ?? [0, 0, 0], offs);
            offs += 4;
        }

        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        for (const r of this.meshRenderers)
            r.prepareToRender(this.renderHelper.renderInstManager, viewerInput);
        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, "Main Color");
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, "Main Depth");
        builder.pushPass((pass) => {
            pass.setDebugName("Main");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(viewerInput);
        builder.execute();
        this.renderInstListMain.reset();
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers(this.meshRenderers.filter((renderer) => !renderer.name.startsWith('Board names and prices@')));
        const languagePanel = new UI.Panel();
        languagePanel.setTitle(LANGUAGE_ICON, 'Language');
        const selector = new UI.SingleSelect();
        selector.setStrings(this.localeChoices.map(([, label]) => label));
        selector.onselectionchange = (index: number) => this.switchLocale(index);
        selector.selectItem(this.initialLocaleIndex);
        languagePanel.contents.appendChild(selector.elem);
        return [layersPanel, languagePanel];
    }

    public destroy(device: GfxDevice): void {
        for (const r of this.meshRenderers)
            r.destroy(device);
        for (const tex of this.gfxTextures)
            device.destroyTexture(tex);
        this.renderHelper.destroy();
    }
}
