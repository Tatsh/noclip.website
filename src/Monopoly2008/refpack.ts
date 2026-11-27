export function isRefPack(data: Uint8Array): boolean {
    return data.length >= 2 && data[1] === 0xFB;
}

export function decompress(data: Uint8Array): Uint8Array {
    let i = 0;
    const b0 = data[i], b1 = data[i + 1];
    i += 2;
    if (b1 !== 0xFB)
        throw new Error(`Monopoly2008: not RefPack (sig ${b0.toString(16)}${b1.toString(16)})`);
    const wide = (b0 & 0x01) !== 0;
    const szlen = wide ? 4 : 3;
    if (b0 & 0x80)
        i += szlen;
    let outsize = 0;
    for (let k = 0; k < szlen; k++)
        outsize = (outsize * 256) + data[i + k];
    i += szlen;

    const out = new Uint8Array(outsize);
    let o = 0;
    const n = data.length;
    while (i < n) {
        const op = data[i++];
        if (op < 0x80) {
            const b = data[i++];
            let num = op & 0x03;
            while (num-- > 0) out[o++] = data[i++];
            let cnt = ((op & 0x1C) >> 2) + 3;
            let ref = o - (((op & 0x60) << 3) + b + 1);
            while (cnt-- > 0) out[o++] = out[ref++];
        } else if (op < 0xC0) {
            const c1 = data[i++], c2 = data[i++];
            let num = (c1 >> 6) & 0x03;
            while (num-- > 0) out[o++] = data[i++];
            let cnt = (op & 0x3F) + 4;
            let ref = o - (((c1 & 0x3F) << 8) + c2 + 1);
            while (cnt-- > 0) out[o++] = out[ref++];
        } else if (op < 0xE0) {
            const c1 = data[i++], c2 = data[i++], c3 = data[i++];
            let num = op & 0x03;
            while (num-- > 0) out[o++] = data[i++];
            let cnt = ((op & 0x0C) << 6) + c3 + 5;
            let ref = o - (((op & 0x10) << 12) + (c1 << 8) + c2 + 1);
            while (cnt-- > 0) out[o++] = out[ref++];
        } else if (op < 0xFC) {
            let num = ((op & 0x1F) << 2) + 4;
            while (num-- > 0) out[o++] = data[i++];
        } else {
            let num = op & 0x03;
            while (num-- > 0) out[o++] = data[i++];
            break;
        }
    }
    return o === out.length ? out : out.subarray(0, o);
}
