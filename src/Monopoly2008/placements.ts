import type { Rpk } from "./rpk.js";
import type { MonopolyMesh } from "./render3d.js";
import { mat4 } from "gl-matrix";

export interface BoardPlacement {
    position: [number, number, number];
    across: [number, number];
    inward: [number, number];
    depth: [number, number];
    textLineHeight?: number;
    textColor?: number;
}

export interface PropertyState {
    index: number;
    group: string;
    inner: BoardPlacement;
    outer: BoardPlacement;
    tile: BoardPlacement;
    owner: number | null;
    mortgaged: boolean;
    monopoly: boolean;
}

export function parseBoardPlacements(rpk: Rpk): Map<string, BoardPlacement> {
    const places = new Map<string, BoardPlacement>();
    for (const asset of rpk.assets) {
        const raw = rpk.buf.subarray(asset.offset, asset.offset + asset.size);
        if (raw.length < 0x60)
            continue;
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (dv.getUint32(0, false) !== 0x66600001)
            continue;
        const nameOffset = dv.getUint32(0x18, false);
        if (nameOffset < 0x60 || nameOffset >= raw.length)
            throw new Error(`Monopoly2008: invalid placement name offset ${nameOffset}`);
        let end = nameOffset;
        while (end < raw.length && raw[end] !== 0)
            end++;
        if (end === raw.length)
            throw new Error(`Monopoly2008: unterminated placement name at ${nameOffset}`);
        const name = String.fromCharCode(...raw.subarray(nameOffset, end));
        const position: BoardPlacement['position'] = [0, 1, 2].map((i) => dv.getFloat32(0x50 + i * 4, false)) as BoardPlacement['position'];
        const across: BoardPlacement['across'] = [dv.getFloat32(0x20, false), dv.getFloat32(0x28, false)];
        const inward: BoardPlacement['inward'] = [dv.getFloat32(0x30, false), dv.getFloat32(0x38, false)];
        const depth: BoardPlacement['depth'] = [dv.getFloat32(0x40, false), dv.getFloat32(0x48, false)];
        if (![...position, ...across, ...inward, ...depth].every(Number.isFinite))
            throw new Error(`Monopoly2008: nonfinite placement ${name}`);
        const lineHeight = raw.length >= 0x98 && dv.getUint32(0x8c, false) === 0x0beccdb4 ? dv.getFloat32(0x94, false) : undefined;
        const textColor = raw.length >= 0xb0 && dv.getUint32(0xa4, false) === 0x0aa50092 ? dv.getUint32(0xac, false) : undefined;
        places.set(name, { position, across, inward, depth, textLineHeight: lineHeight && Number.isFinite(lineHeight) && lineHeight > 0 && lineHeight < 10 ? lineHeight : undefined, textColor });
    }
    return places;
}

export function placeBoardActors(meshes: MonopolyMesh[], places: Map<string, BoardPlacement>, id: string): void {
    const go = places.get('Corner_Go.Corner_Go_Tile');
    const jail = places.get('Corner_Jail.Corner_Jail_Tile');
    const parking = places.get('Corner_Free_Parking.Corner_Free_Parking_Tile');
    const goToJail = places.get('Corner_GoTo_Jail.Corner_GoTo_Jail_Tile');
    if (!go || !jail || !parking || !goToJail)
        throw new Error(`Monopoly2008: missing board corners for ${id}`);
    const centerX = (go.position[0] + jail.position[0] + parking.position[0] + goToJail.position[0]) / 4;
    const centerZ = (go.position[2] + jail.position[2] + parking.position[2] + goToJail.position[2]) / 4;
    const jailMesh = meshes.find((m) => m.name === 'wm_jail_common');
    if (!jailMesh)
        throw new Error('Monopoly2008: missing shared jail mesh');
    jailMesh.instances = [mat4.fromTranslation(mat4.create(), [jail.position[0], jail.position[1] - jailMesh.mesh.bmin[1], jail.position[2]])];
    const dice = meshes.find((m) => m.name === `wm_dice_${id}`);
    const board = meshes.find((m) => m.name === `wm_board_${id}`);
    if (!dice || !board)
        throw new Error(`Monopoly2008: missing dice or board for ${id}`);
    const boardHeightAt = (x: number, z: number): number => {
        let height = -Infinity;
        for (const part of board.mesh.submeshes) for (let i = 0; i < part.indices.length; i += 3) {
            const a = part.indices[i] * 3, b = part.indices[i + 1] * 3, c = part.indices[i + 2] * 3;
            const p = part.positions;
            const det = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
            if (Math.abs(det) < 1e-6) continue;
            const u = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / det;
            const v = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / det;
            if (u < -1e-4 || v < -1e-4 || u + v > 1.0001) continue;
            height = Math.max(height, u * p[a + 1] + v * p[b + 1] + (1 - u - v) * p[c + 1]);
        }
        if (!Number.isFinite(height)) throw new Error(`Monopoly2008: no dice surface at ${x}, ${z} on ${id}`);
        return height;
    };
    dice.instances = [-2, 2].map((offset) => {
        const x = centerX + offset;
        const z = centerZ - 8;
        const model = mat4.fromTranslation(mat4.create(), [x, boardHeightAt(x, z) - dice.mesh.bmin[1], z]);
        mat4.rotateY(model, model, Math.floor(Math.random() * 4) * Math.PI / 2);
        return model;
    });

    const tiles = [...places.entries()].filter(([name]) => name.endsWith('_Tile'));
    if (tiles.length < 4)
        throw new Error(`Monopoly2008: fewer than four board tiles for ${id}`);
    for (let player = 1; player <= 4; player++) {
        const piece = meshes.find((m) => m.name === `wm_player_${player}_${id}`);
        if (!piece)
            throw new Error(`Monopoly2008: missing player ${player} for ${id}`);
        const pick = Math.floor(Math.random() * tiles.length);
        const [, tile] = tiles.splice(pick, 1)[0];
        const model = mat4.fromTranslation(mat4.create(), [tile.position[0], tile.position[1] - piece.mesh.bmin[1] + 0.03, tile.position[2]]);
        mat4.rotateY(model, model, Math.floor(Math.random() * 4) * Math.PI / 2);
        piece.instances = [model];
    }
}

export function placeBoardProperties(meshes: MonopolyMesh[], places: Map<string, BoardPlacement>, id: string): PropertyState[] {
    const properties = Array.from({ length: 28 }, (_, i) => {
        const prefix = `Property${String(i).padStart(2, '0')}.`;
        const innerEntry = [...places.entries()].find(([name]) => name.startsWith(prefix) && name.endsWith('_A'));
        const inner = innerEntry?.[1];
        const outer = [...places.entries()].find(([name]) => name.startsWith(prefix) && name.endsWith('_C'))?.[1];
        const tile = [...places.entries()].find(([name]) => name.startsWith(prefix) && (name.endsWith('_Tile') || name.endsWith('_Site_Utility')))?.[1];
        if (!inner || !outer || !tile)
            throw new Error(`Monopoly2008: missing property ${i} placements for ${id}`);
        const group = innerEntry![0].match(/Property_([^.]*)_A$/)?.[1];
        if (!group)
            throw new Error(`Monopoly2008: missing property group for ${i}`);
        return { index: i, inner, outer, tile, group, buildable: group !== 'Station' && group !== 'Utility' };
    });
    for (let i = properties.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [properties[i], properties[j]] = [properties[j], properties[i]];
    }
    const ownedCount = 14 + Math.floor(Math.random() * 6);
    const mortgageCount = 2 + Math.floor(Math.random() * 3);
    const states: PropertyState[] = properties.map(({ index, group, inner, outer, tile }, i) => ({
        index, group, inner, outer, tile,
        owner: group === 'Brown' ? 1 : group === 'Red' ? 2 : i < ownedCount ? i % 4 + 1 : null,
        mortgaged: false,
        monopoly: false,
    }));
    const groups = new Map<string, PropertyState[]>();
    for (const state of states) {
        if (state.group === 'Station' || state.group === 'Utility')
            continue;
        const members = groups.get(state.group) ?? [];
        members.push(state);
        groups.set(state.group, members);
    }
    for (const members of groups.values())
        if (members.every((state) => state.owner !== null && state.owner === members[0].owner))
            members.forEach((state) => state.monopoly = true);
    states.filter((state) => state.owner !== null && !state.monopoly).slice(0, mortgageCount).forEach((state) => state.mortgaged = true);
    const frame = meshes.find((m) => m.name === 'wm_property_frame_monopoly_01');
    if (!frame)
        throw new Error('Monopoly2008: missing shared monopoly frame');
    frame.instances = states.filter((state) => state.monopoly).map((state) => {
        const model = mat4.fromTranslation(mat4.create(), [state.tile.position[0], state.outer.position[1] + 0.02, state.tile.position[2]]);
        mat4.rotateY(model, model, -Math.atan2(state.tile.across[1], state.tile.across[0]));
        return model;
    });

    const tagTheme = id === 'worldwide' ? 'deco' : id;
    const tags = Array.from({ length: 4 }, (_, i) => meshes.find((m) => m.name === `wm_playertag_${tagTheme}_0${i + 1}`));
    const monopolyTags = Array.from({ length: 4 }, (_, i) => meshes.find((m) => m.name === `wm_playertag_${tagTheme}_0${i + 1}_monopoly`));
    if (tags.some((tag) => !tag) || monopolyTags.some((tag) => !tag))
        throw new Error(`Monopoly2008: missing ownership tags for ${id}`);
    for (const tag of [...tags, ...monopolyTags])
        tag!.instances = [];
    const buildings = meshes.filter((m) => m.name.startsWith('wm_house_') || m.name.startsWith('wm_hotel_'));
    if (!buildings.some((m) => m.name.startsWith('wm_house_')) || !buildings.some((m) => m.name.startsWith('wm_hotel_')))
        throw new Error(`Monopoly2008: missing buildings for ${id}`);
    for (const building of buildings)
        building.instances = [];

    const redHouses = 1 + Math.floor(Math.random() * 4);
    properties.forEach(({ inner, outer, tile, buildable }, i) => {
        const state = states[i];
        if (state.owner === null)
            return;
        const tag = (state.monopoly ? monopolyTags : tags)[state.owner - 1]!;
        const length = Math.hypot(...outer.across);
        const outerDepth = Math.hypot(...outer.inward);
        const tileDepth = Math.hypot(...tile.depth);
        if (length === 0 || outerDepth === 0 || tileDepth === 0)
            throw new Error(`Monopoly2008: zero-area ownership spot for ${id}`);
        const yaw = Math.atan2(outer.across[0], outer.across[1]) - Math.PI / 2;
        let visibleMinZ = Infinity;
        for (const part of tag.mesh.submeshes) {
            if (tag.mesh.materials[part.materialIndex].textures.some((texture) => texture.name.endsWith('_shadow_cm')))
                continue;
            for (let vertex = 2; vertex < part.positions.length; vertex += 3)
                visibleMinZ = Math.min(visibleMinZ, part.positions[vertex]);
        }
        if (!Number.isFinite(visibleMinZ))
            throw new Error(`Monopoly2008: missing visible ownership tag geometry for ${id}`);
        const markerDepth = tileDepth / 2 - Math.min(0, visibleMinZ);
        const marker = mat4.fromTranslation(mat4.create(), [tile.position[0] - outer.inward[0] / outerDepth * markerDepth, 0, tile.position[2] - outer.inward[1] / outerDepth * markerDepth]);
        mat4.rotateY(marker, marker, yaw);
        tag.instances!.push(marker);

        if (!buildable || !state.monopoly || state.mortgaged || (state.group !== 'Brown' && state.group !== 'Red'))
            return;
        const type = state.group === 'Brown' ? 'hotel' : 'house';
        const variant = id === 'worldwide' ? `${i % 6 + 1}_worldwide` : id;
        const building = meshes.find((m) => m.name === `wm_${type}_${variant}`);
        if (!building)
            throw new Error(`Monopoly2008: missing ${type} ${variant}`);
        const count = type === 'hotel' ? 1 : redHouses;
        const innerWidth = Math.hypot(...inner.across);
        const innerDepth = Math.hypot(...inner.inward);
        if (innerWidth === 0 || innerDepth === 0)
            throw new Error(`Monopoly2008: zero-area building spot for ${id}`);
        const [ax, az] = inner.across.map((v) => v / innerWidth);
        for (let n = 0; n < count; n++) {
            const offset = (n - (count - 1) / 2) * 0.9;
            const model = mat4.fromTranslation(mat4.create(), [inner.position[0] + ax * offset + inner.inward[0] / innerDepth * 1.8, inner.position[1] - building.mesh.bmin[1], inner.position[2] + az * offset + inner.inward[1] / innerDepth * 1.8]);
            mat4.rotateY(model, model, Math.atan2(inner.across[0], inner.across[1]) + Math.PI / 2);
            building.instances!.push(model);
        }
    });
    return states;
}
