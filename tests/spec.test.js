/*
 * Executable checks for public/docs/anim-format.md.
 *
 * These tests assert the exact behaviour the specification documents (the
 * reference trace in §11), so the document cannot silently drift away from the
 * implementation.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { AnimPlayer } from '../src/player.js';
import { Renderer } from '../src/renderer.js';

const here = dirname(fileURLToPath(import.meta.url));
const program = JSON.parse(readFileSync(join(here, 'fixtures', 'sample', 'program.json'), 'utf8'));

function texture(width, height, [r, g, b, a = 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        data[index + 3] = a;
    }
    return { width, height, data };
}

function pixel(renderer, x, y) {
    const index = (y * renderer.width + x) * 4;
    return Array.from(renderer.buffer.slice(index, index + 4));
}

async function loadReferenceProgram() {
    const textures = {
        // §11: frame0 = 4x4 red block in the top-left of an 8x8 image
        'frame0.png': (() => {
            const image = texture(8, 8, [0, 0, 0, 0]);
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const index = (y * 8 + x) * 4;
                    image.data[index] = 255;
                    image.data[index + 1] = 0;
                    image.data[index + 2] = 0;
                    image.data[index + 3] = 255;
                }
            }
            return image;
        })(),
        'frame1.png': texture(8, 8, [0, 200, 0]),
    };

    const blobs = new Map(Object.keys(textures).map((path) => [
        path,
        Object.assign(new Blob([path]), { name: path }),
    ]));

    const renderer = new Renderer();
    const player = new AnimPlayer({ renderer, decode: async (blob) => textures[blob.name] });

    // Record the drawFrame calls per tick, like a host would for debugging.
    const drawn = [];
    let current = [];
    const drawTexture = renderer.drawTexture.bind(renderer);
    renderer.drawTexture = (index) => {
        current.push(index);
        return drawTexture(index);
    };

    const result = await player.load(program, {
        resolve: async (path) => blobs.get(path) || null,
    });

    const tick = () => {
        current = [];
        player.tick();
        drawn.push(current);
        return {
            drawn: current,
            index: player.context.anim_anim_0_index,
            tick: player.context.anim_anim_0_tick,
        };
    };

    return { renderer, player, result, tick, drawn };
}

test('spec §3/§11: loadImage order, hotspots and buffer size', async () => {
    const { renderer, result } = await loadReferenceProgram();

    assert.equal(result.textures, 2);
    assert.deepEqual(
        renderer.textures.map((entry) => ({ path: entry.path, hotspotX: entry.hotspotX, hotspotY: entry.hotspotY })),
        [
            { path: 'frame0.png', hotspotX: 0, hotspotY: 0 },
            { path: 'frame1.png', hotspotX: -4, hotspotY: -2 },
        ],
    );

    // §6.3 bounding box: texture 0 at (0,0), texture 1 at (4,2), both 8x8.
    assert.equal(renderer.width, 12);
    assert.equal(renderer.height, 10);
    assert.equal(renderer.originX, 0);
    assert.equal(renderer.originY, 0);
});

test('spec §7/§11: the initial context state written by the program', async () => {
    const { player } = await loadReferenceProgram();

    assert.deepEqual(player.context, {
        anim_anim_0_index: 0,
        anim_anim_0_active: 1,
        anim_anim_0_yy_direction: 1,
        anim_anim_0_tick: 0,
    });
});

test('spec §11: the reference trace table', async () => {
    const { tick } = await loadReferenceProgram();

    assert.deepEqual(tick(), { drawn: [0], index: 0, tick: 1 });
    assert.deepEqual(tick(), { drawn: [0], index: 1, tick: 0 });
    assert.deepEqual(tick(), { drawn: [1], index: 1, tick: 1 });
    assert.deepEqual(tick(), { drawn: [1], index: 0, tick: 0 });
    assert.deepEqual(tick(), { drawn: [0], index: 0, tick: 1 });
    assert.deepEqual(tick(), { drawn: [0], index: 1, tick: 0 });
});

test('spec §6.1/§11: the frame buffer persists between frames', async () => {
    const { renderer, tick } = await loadReferenceProgram();

    tick(); // frame 0 drawn
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);

    tick(); // frame 0 again, index becomes 1
    tick(); // frame 1 drawn at (4,2)
    assert.deepEqual(pixel(renderer, 4, 2), [0, 200, 0, 255]);

    tick(); // frame 1 again, index becomes 0
    tick(); // frame 0 drawn again: it does not cover (4,2)
    assert.deepEqual(pixel(renderer, 4, 2), [0, 200, 0, 255], 'the green pixel survives because the buffer is not cleared');
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);
});

test('spec §7: a host can stop an animation with _active = 0', async () => {
    const { player, renderer, tick } = await loadReferenceProgram();

    tick();
    const drawsBefore = renderer.drawCalls;
    player.context.anim_anim_0_active = 0;
    tick();
    tick();
    assert.equal(renderer.drawCalls, drawsBefore, 'a stopped animation draws nothing');
    assert.equal(player.context.anim_anim_0_index, 0, 'and does not advance');
});

test('spec §7: _active = -1 draws once more and then stops', async () => {
    const { player, renderer, tick } = await loadReferenceProgram();

    tick();
    const drawsBefore = renderer.drawCalls;
    player.context.anim_anim_0_active = -1;

    const afterOneMoreFrame = tick();
    assert.equal(renderer.drawCalls, drawsBefore + 1, 'the current frame is drawn once more');
    assert.deepEqual(afterOneMoreFrame.drawn, [0]);

    const afterStop = tick();
    assert.deepEqual(afterStop.drawn, [], 'the animation is stopped');
    assert.equal(player.context.anim_anim_0_active, 0, 'the epilogue turned -1 into 0');
});
