import type { Npm7Mesh, Npm7Submesh } from './npm7.js';
import type { PropertyState } from './placements.js';

export function buildBoardStateMesh(states: PropertyState[]): Npm7Mesh {
    const materials = ['Mortgage_property_squares', 'mortgage_UtilStation_squares']
        .map((name) => ({ textures: [{ name, type: 0, slot: 0 }], renderMode: 2, featureFlags: 4 }));
    const submeshes: Npm7Submesh[] = [];
    const bmin: [number, number, number] = [Infinity, Infinity, Infinity];
    const bmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const state of states) {
        if (!state.mortgaged)
            continue;
        const acrossLength = Math.hypot(...state.tile.across);
        const depthLength = Math.hypot(...state.tile.depth);
        if (!acrossLength || !depthLength)
            throw new Error(`Monopoly2008: zero-area property ${state.index}`);
        const across = state.tile.across.map((v) => v / acrossLength);
        const inward = state.tile.depth.map((v) => v / depthLength);
        const centerX = state.tile.position[0];
        const centerZ = state.tile.position[2];
        const y = state.outer.position[1] + 0.025;
        const outerEdge = (state.outer.position[0] - centerX) * inward[0] + (state.outer.position[2] - centerZ) * inward[1];
        if (outerEdge <= 0 || outerEdge >= depthLength / 2)
            throw new Error(`Monopoly2008: invalid mortgage placement for property ${state.index}`);
        const makeQuad = (left: number, top: number, right: number, bottom: number, materialIndex: number) => {
            const positions: number[] = [];
            for (const [x, z] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
                const px = centerX + across[0] * x + inward[0] * z;
                const pz = centerZ + across[1] * x + inward[1] * z;
                positions.push(px, y, pz);
                bmin[0] = Math.min(bmin[0], px); bmin[1] = Math.min(bmin[1], y); bmin[2] = Math.min(bmin[2], pz);
                bmax[0] = Math.max(bmax[0], px); bmax[1] = Math.max(bmax[1], y); bmax[2] = Math.max(bmax[2], pz);
            }
            submeshes.push({ positions: Float32Array.from(positions), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
                uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), materialIndex });
        };
        makeQuad(-acrossLength / 2, -depthLength / 2, acrossLength / 2, outerEdge,
            state.group === 'Station' || state.group === 'Utility' ? 1 : 0);
    }
    return { format: 'board state', transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], pivot: [0, 0, 0], bmin, bmax, materials, submeshes };
}
