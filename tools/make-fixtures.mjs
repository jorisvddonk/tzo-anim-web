/*
 * Generates the test fixtures in tests/fixtures/:
 *
 *   sample/program.json   a hand-written TZO animation program (2 frames,
 *                         CIRCULAR, one frame every 2 ticks)
 *   sample/frame0.png     8x8, hotspot (0,0), red square
 *   sample/frame1.png     8x8, hotspot (-4,-2), green square
 *   sample.zip            the same files, inside a "sample/" folder
 *
 * The PNGs are encoded by hand (zlib + CRC) so the fixtures have no external
 * dependencies and the repository stays small.
 *
 * Usage: node tools/make-fixtures.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'tests', 'fixtures');
const sampleDir = join(outDir, 'sample');

/* ------------------------------------------------------------------ */
/* Minimal PNG encoder (RGBA, 8 bit, no filtering)                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBytes = strToU8(type);
    const payload = new Uint8Array(typeBytes.length + data.length);
    payload.set(typeBytes, 0);
    payload.set(data, typeBytes.length);

    const out = new Uint8Array(4 + payload.length + 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(payload, 4);
    view.setUint32(4 + payload.length, crc32(payload));
    return out;
}

function encodePng(width, height, rgba) {
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const header = new Uint8Array(13);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, width);
    headerView.setUint32(4, height);
    header[8] = 8;  // bit depth
    header[9] = 6;  // colour type: RGBA
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace

    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter type: none
        raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }

    const parts = [
        signature,
        chunk('IHDR', header),
        chunk('IDAT', new Uint8Array(deflateSync(raw))),
        chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const png = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        png.set(part, offset);
        offset += part.length;
    }
    return png;
}

/** 8x8 image with a coloured block in the top-left and transparent elsewhere. */
function frame(color, blockWidth, blockHeight) {
    const size = 8;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < blockHeight; y++) {
        for (let x = 0; x < blockWidth; x++) {
            const index = (y * size + x) * 4;
            pixels[index] = color[0];
            pixels[index + 1] = color[1];
            pixels[index + 2] = color[2];
            pixels[index + 3] = 255;
        }
    }
    return encodePng(size, size, pixels);
}

/* ------------------------------------------------------------------ */
/* Program builder (same conventions as the tzo-anim exporter)         */
/* ------------------------------------------------------------------ */

function buildProgram() {
    const program = [];
    const pushNumber = (value) => program.push({ type: 'push-number-instruction', value });
    const pushString = (value) => program.push({ type: 'push-string-instruction', value });
    const invoke = (functionName) => program.push({ type: 'invoke-function-instruction', functionName });
    const ifBlock = (condition, body) => {
        condition();
        invoke('jgz');
        invoke('{');
        body();
        invoke('}');
    };

    const key = (suffix) => `anim_anim_0_${suffix}`;

    // loadImage(hotspotY, hotspotX, path)
    pushNumber(0);
    pushNumber(0);
    pushString('frame0.png');
    invoke('loadImage');

    pushNumber(-2);
    pushNumber(-4);
    pushString('frame1.png');
    invoke('loadImage');

    // animation state
    pushNumber(0);
    pushString(key('index'));
    invoke('setContext');
    pushNumber(1);
    pushString(key('active'));
    invoke('setContext');
    pushNumber(1);
    pushString(key('yy_direction'));
    invoke('setContext');
    pushNumber(0);
    pushString(key('tick'));
    invoke('setContext');

    invoke('pause');

    const loopStart = program.length;
    invoke('nop');
    invoke('beginDraw');

    for (const index of [0, 1]) {
        ifBlock(
            () => {
                pushString(key('active'));
                invoke('getContext');
                pushNumber(0);
                invoke('eq');
                invoke('not');
            },
            () => {
                ifBlock(
                    () => {
                        pushString(key('index'));
                        invoke('getContext');
                        pushNumber(index);
                        invoke('eq');
                    },
                    () => {
                        pushNumber(index);
                        invoke('drawFrame');
                    },
                );
            },
        );
    }

    invoke('endDraw');

    // tick++ and advance every 2 ticks
    ifBlock(
        () => {
            pushString(key('active'));
            invoke('getContext');
            pushNumber(0);
            invoke('eq');
            invoke('not');
        },
        () => {
            pushString(key('tick'));
            invoke('getContext');
            pushNumber(1);
            invoke('+');
            pushString(key('tick'));
            invoke('setContext');

            ifBlock(
                () => {
                    pushNumber(2);
                    pushString(key('tick'));
                    invoke('getContext');
                    invoke('lt');
                    invoke('not');
                },
                () => {
                    pushNumber(0);
                    pushString(key('tick'));
                    invoke('setContext');

                    pushString(key('index'));
                    invoke('getContext');
                    pushNumber(1);
                    invoke('+');
                    pushString(key('index'));
                    invoke('setContext');

                    ifBlock(
                        () => {
                            pushString(key('index'));
                            invoke('getContext');
                            pushNumber(2);
                            invoke('eq');
                        },
                        () => {
                            pushNumber(0);
                            pushString(key('index'));
                            invoke('setContext');
                        },
                    );
                },
            );
        },
    );

    invoke('pause');
    pushString('mainAnimationLoop');
    invoke('goto');

    return {
        context: {},
        exit: false,
        pause: false,
        labelMap: { mainAnimationLoop: loopStart },
        programList: program,
        programCounter: 0,
        stack: [],
    };
}

/* ------------------------------------------------------------------ */

mkdirSync(sampleDir, { recursive: true });

const frame0 = frame([255, 0, 0], 4, 4);
const frame1 = frame([0, 200, 0], 8, 8);
const programJson = `${JSON.stringify(buildProgram(), null, 2)}\n`;

writeFileSync(join(sampleDir, 'frame0.png'), frame0);
writeFileSync(join(sampleDir, 'frame1.png'), frame1);
writeFileSync(join(sampleDir, 'program.json'), programJson);

const zip = zipSync({
    'sample/program.json': strToU8(programJson),
    'sample/frame0.png': frame0,
    'sample/frame1.png': frame1,
}, { level: 9 });
writeFileSync(join(outDir, 'sample.zip'), zip);

console.log(`wrote ${join(sampleDir, 'program.json')} (${programJson.length} bytes)`);
console.log(`wrote ${join(sampleDir, 'frame0.png')}, frame1.png`);
console.log(`wrote ${join(outDir, 'sample.zip')} (${zip.length} bytes)`);
