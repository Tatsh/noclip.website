import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { mat4 } from 'gl-matrix';
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import * as Viewer from "../viewer.js";
import { parseRPK } from "./rpk.js";
import { decodeXMAP } from "./xmap.js";
import { parseNPM7 } from "./npm7.js";
import { MonopolyScene3D, MonopolyMesh, MonopolyTexture } from "./render3d.js";
import { parseBoardPlacements, placeBoardActors, placeBoardProperties } from "./placements.js";
import { parseFNTX, parsePropertyNames, parseSpecialNames, buildPropertyTextMesh, boardFontTextureName } from "./font.js";
import { buildBoardStateMesh } from './boardState.js';
import { parseRoomLighting } from './lighting.js';
import { parseCharacterSkeleton, parseIdleMotion, SkinPose } from './motion.js';

const pathBase = "Monopoly2008";

function parseRoomModelInstances(rpk: ReturnType<typeof parseRPK>): Map<number, mat4[]> {
    const models = new Set(rpk.assets.filter((asset) => asset.magic === 'NPM7').map((asset) => asset.nameHash));
    const instances = new Map<number, mat4[]>();
    for (const asset of rpk.assets) {
        const raw = rpk.buf.subarray(asset.offset, asset.offset + asset.size);
        if (raw.length < 0x80)
            continue;
        const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (data.getUint32(0, false) !== 0x66600001)
            continue;
        const nameOffset = data.getUint32(0x18, false);
        if (nameOffset > raw.length)
            throw new Error(`Monopoly2008: invalid room entity ${asset.name}`);
        for (let offset = 0x60; offset + 12 <= nameOffset; offset += 4) {
            if (data.getUint32(offset, false) !== 0x0c9f4105 || data.getUint32(offset + 4, false) !== 0x10)
                continue;
            const modelHash = data.getUint32(offset + 8, false);
            if (!models.has(modelHash))
                continue;
            const f = (row: number, column: number) => data.getFloat32(0x20 + row * 0x10 + column * 4, false);
            const model = mat4.fromValues(f(0, 0), f(1, 0), f(2, 0), 0, f(0, 1), f(1, 1), f(2, 1), 0,
                f(0, 2), f(1, 2), f(2, 2), 0, f(3, 0), f(3, 1), f(3, 2), 1);
            if (!Array.from(model).every(Number.isFinite))
                throw new Error(`Monopoly2008: invalid room transform ${asset.name}`);
            const list = instances.get(modelHash) ?? [];
            list.push(model);
            instances.set(modelHash, list);
        }
    }
    return instances;
}

class MonopolyTextureSceneDesc implements SceneDesc {
    private packs: string[];
    constructor(public id: string, public name: string, packs: string[], private boardId: string) {
        this.packs = packs;
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const { dataFetcher } = context;
        const textures: MonopolyTexture[] = [];
        const meshes: MonopolyMesh[] = [];
        const seenTex = new Set<string>();
        const seenMesh = new Set<string>();
        let boardPlaces: ReturnType<typeof parseBoardPlacements> | undefined;
        let roomLighting: ReturnType<typeof parseRoomLighting>;
        let characterSkeleton: Uint8Array | undefined;
        let idleBank: Uint8Array | undefined;
        let defaultPack: ReturnType<typeof parseRPK> | undefined;
        for (let start = 0; start < this.packs.length; start += 4) {
            const packs = this.packs.slice(start, start + 4);
            const data = await Promise.all(packs.map((pack) => dataFetcher.fetchData(`${pathBase}/${pack}`)));
            for (let i = 0; i < packs.length; i++) {
                const pack = packs[i];
                const rpk = parseRPK(data[i]);
                const shared = pack === 'chapters/standard.rpk';
                const roomInstances = pack.includes('/env_') ? parseRoomModelInstances(rpk) : undefined;
                if (pack.endsWith(`/board_${this.boardId}/en-us.rpk`)) {
                    boardPlaces = parseBoardPlacements(rpk);
                    defaultPack = rpk;
                }
                if (pack.includes('/env_'))
                    roomLighting = parseRoomLighting(rpk);
                for (const a of rpk.assets) {
                    const raw = rpk.buf.subarray(a.offset, a.offset + a.size);
                    if (pack.endsWith('/property_mrmono.rpk')) {
                        if (a.name === 'Mr_Monopoly') characterSkeleton = raw;
                        if (a.name === 'frontend') idleBank = raw;
                    }
                    if (a.magic === 'PAMX') {
                        if (shared && !a.name.startsWith('wt_jail_') && a.name !== 'wt_property_frame_monopoly_cm')
                            continue;
                        const tex = decodeXMAP(raw);
                        let name = a.name;
                        while (seenTex.has(name))
                            name = `${name}_`;
                        seenTex.add(name);
                        textures.push({ name, tex });
                    } else if (a.magic === 'NPM7') {
                        {
                            const board = pack.endsWith(`/board_${this.boardId}/en-us.rpk`) && a.name === `wm_board_${this.boardId}`;
                            const room = pack.endsWith(`/env_${this.boardId}.rpk`);
                            const actor = a.name === `wm_dice_${this.boardId}` || new RegExp(`^wm_player_[1-4]_${this.boardId}$`).test(a.name);
                            const tagTheme = this.boardId === 'worldwide' ? 'deco' : this.boardId;
                            const marker = new RegExp(`^wm_playertag_${tagTheme}_0[1-4](_monopoly)?$`).test(a.name) && pack.endsWith(`/pieces_${this.boardId}.rpk`);
                            const property = pack.includes('/property_');
                            const sharedModel = shared && (a.name === 'wm_jail_common' || a.name === 'wm_property_frame_monopoly_01');
                            if (!board && !room && !actor && !marker && !property && !sharedModel)
                                continue;
                        }
                        const mesh = parseNPM7(raw);
                        if (mesh.submeshes.length === 0)
                            continue;
                        let name = a.name;
                        while (seenMesh.has(name))
                            name = `${name}_`;
                        seenMesh.add(name);
                        meshes.push({ name, mesh, instances: roomInstances?.get(a.nameHash) });
                    }
                }
            }
        }
        {
            if (!boardPlaces || !defaultPack)
                throw new Error(`Monopoly2008: missing board placements for ${this.boardId}`);
            const character = meshes.find((m) => m.name === 'cm_mrm_bindpose_LOD_3');
            const go = boardPlaces.get('Corner_Go.Corner_Go_Tile');
            if (!character || !go || !characterSkeleton || !idleBank)
                throw new Error('Monopoly2008: missing Mr Monopoly idle resources');
            const skeleton = parseCharacterSkeleton(characterSkeleton);
            if (new DataView(idleBank.buffer, idleBank.byteOffset, idleBank.byteLength).getUint32(0x1c, false) !== skeleton.character)
                throw new Error('Monopoly2008: Mr Monopoly motion bank targets another skeleton');
            character.skinPose = new SkinPose(character.mesh, skeleton, parseIdleMotion(idleBank));
            const corner = mat4.fromTranslation(mat4.create(), [go.position[0] - (go.across[0] + go.depth[0]) / 2 - 1.5, go.position[1], go.position[2] - (go.across[1] + go.depth[1]) / 2 - 1.5]);
            mat4.rotateY(corner, corner, -Math.PI / 4);
            character.instances = [corner];
            placeBoardActors(meshes, boardPlaces, this.boardId);
            const states = placeBoardProperties(meshes, boardPlaces, this.boardId);
            const namesId = this.boardId === 'classic' ? 'atlanticcity' : this.boardId;
            const defaultTextures = new Map(defaultPack.assets.filter((a) => a.magic === 'PAMX').map((a) => [a.name, defaultPack.buf.subarray(a.offset, a.offset + a.size)]));
            for (const [locale] of LOCALES) {
                let localePlaces = boardPlaces;
                const [boardData, namesData, fontData] = await Promise.all([
                    locale === 'en-us' ? undefined : dataFetcher.fetchData(`${pathBase}/${STD}/board_${this.boardId}/${locale}.rpk`),
                    dataFetcher.fetchData(`${pathBase}/${STD}/names_${namesId}/${locale}.rpk`),
                    dataFetcher.fetchData(`${pathBase}/game/localised/${locale}.rpk`),
                ]);
                if (boardData) {
                    const boardPack = parseRPK(boardData);
                    localePlaces = parseBoardPlacements(boardPack);
                    for (const a of boardPack.assets.filter((a) => a.magic === 'PAMX')) {
                        const raw = boardPack.buf.subarray(a.offset, a.offset + a.size);
                        const original = defaultTextures.get(a.name);
                        if (original && raw.length === original.length && raw.every((value, i) => value === original[i]))
                            continue;
                        textures.push({ name: `${a.name}@${locale}`, tex: decodeXMAP(raw) });
                    }
                }
                const namesPack = parseRPK(namesData);
                const fontRpk = parseRPK(fontData);
                const fontAsset = fontRpk.assets.find((a) => a.magic === 'FntX' && a.nameHash === 0x06c9019f);
                if (!fontAsset)
                    throw new Error(`Monopoly2008: missing Book bitmap font for ${locale}`);
                const font = parseFNTX(fontRpk.buf.subarray(fontAsset.offset, fontAsset.offset + fontAsset.size));
                const fontTexture = `${boardFontTextureName}@${locale}`;
                textures.push({ name: fontTexture, tex: font.texture });
                const textMesh = buildPropertyTextMesh(font, parsePropertyNames(namesPack), localePlaces, parseSpecialNames(namesPack, this.boardId), this.boardId);
                textMesh.materials[0].textures[0].name = fontTexture;
                meshes.push({ name: `Board names and prices@${locale}`, mesh: textMesh });
            }
            meshes.push({ name: 'Mortgages', mesh: buildBoardStateMesh(states) });
        }
        const linkedScene = decodeURIComponent(window.location.hash.slice(1)).split(';', 1)[0];
        const linkedLocale = LOCALES.findIndex(([locale]) => linkedScene === `Monopoly2008/${this.boardId}-${locale}`);
        return new MonopolyScene3D(device, meshes, textures, `wm_board_${this.boardId}`, roomLighting, LOCALES, Math.max(0, linkedLocale));
    }
}

const STD = "chapters/standard";

const CHAPTERS: { id: string, name: string }[] = [
    { id: "classic",   name: "Classic" },
    { id: "sipod",     name: "Future" },
    { id: "cardboard", name: "Cardboard" },
    { id: "cheese",    name: "Cheese" },
    { id: "deco",      name: "Deco" },
    { id: "ice",       name: "Ice" },
    { id: "jungle",    name: "Jungle" },
    { id: "sweet",     name: "Sweet" },
    { id: "worldwide", name: "Worldwide" },
];
const LOCALES = [
    ['en-us', 'English (US)'], ['en-gb', 'English (UK)'], ['de-de', 'Deutsch'],
    ['es-es', 'Español (Spain)'], ['es-mx', 'Español (Mexico)'], ['fr-fr', 'Français'],
] as const;

function propertyPacks(id: string): string[] {
    if (id === "worldwide") {
        const out: string[] = [];
        for (let i = 1; i <= 6; i++)
            out.push(`${STD}/property_worldwide_${i}.rpk`);
        return out;
    }
    return [`${STD}/property_${id}.rpk`];
}

function piecePacks(id: string): string[] {
    const out = [`${STD}/pieces_${id}.rpk`];
    for (let i = 1; i <= 6; i++)
        out.push(`${STD}/pieces_${id}/piece_${i}_${id}.rpk`);
    return out;
}

const sceneDescs: (string | SceneDesc)[] = [];
for (const c of CHAPTERS) {
    sceneDescs.push(new MonopolyTextureSceneDesc(c.id, c.name, [`chapters/standard.rpk`, `${STD}/board_${c.id}/en-us.rpk`, `${STD}/env_${c.id}.rpk`, `${STD}/pieces_${c.id}.rpk`, ...piecePacks(c.id).slice(1, 5), ...propertyPacks(c.id), `${STD}/property_mrmono.rpk`], c.id));
}

/** Unique identifier for the Monopoly 2008 scene group. */
export const id = "Monopoly2008";
/** Display name for the Monopoly 2008 scene group. */
export const name = "Monopoly (2008)";
/** Scene group definition for the Monopoly 2008 viewer. */
const sceneIdMap = new Map(CHAPTERS.flatMap((chapter) => LOCALES.map(([locale]) => [`${chapter.id}-${locale}`, chapter.id] as const)));
export const sceneGroup: SceneGroup = { id, name, sceneDescs, sceneIdMap };
