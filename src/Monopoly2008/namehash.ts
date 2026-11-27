export function nameHash(name: string, stopAtExtension = true): number {
    let h = 0;
    for (let k = 0; k < name.length; k++) {
        let c = name.charCodeAt(k);
        if (stopAtExtension && c === 0x2E)
            break;
        if (c >= 0x41 && c <= 0x5A)
            c += 0x20;
        h = (((h & 0x0FFFFFFF) * 16) + c) >>> 0;
        const top = h & 0xF0000000;
        if (top !== 0)
            h ^= top >>> 24;
        h = (h & ~top) >>> 0;
    }
    return h >>> 0;
}
