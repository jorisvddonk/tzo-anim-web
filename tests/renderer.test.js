import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Renderer } from '../src/renderer.js';

function solidTexture(width, height, [r, g, b, a]) {
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

test('fitToTextures uses the bounding box of all textures and their hotspots', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(8, 8, [255, 0, 0, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.addTexture({ ...solidTexture(8, 8, [0, 200, 0, 255]), hotspotX: -4, hotspotY: -2 });
    renderer.fitToTextures();

    assert.equal(renderer.width, 12);
    assert.equal(renderer.height, 10);
    assert.equal(renderer.originX, 0);
    assert.equal(renderer.originY, 0);
});

test('drawTexture places sprites relative to their hotspot', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(8, 8, [255, 0, 0, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.addTexture({ ...solidTexture(8, 8, [0, 200, 0, 255]), hotspotX: -4, hotspotY: -2 });
    renderer.fitToTextures();
    renderer.clear();

    assert.equal(renderer.drawTexture(0), true);
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(renderer, 9, 7), [0, 0, 0, 0]);

    assert.equal(renderer.drawTexture(1), true);
    assert.deepEqual(pixel(renderer, 4, 2), [0, 200, 0, 255]);
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255], 'frame 0 is still there (persistent buffer)');
});

test('positive hotspot offsets shift the whole scene into view', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(8, 8, [255, 0, 0, 255]), hotspotX: 4, hotspotY: 2 });
    renderer.fitToTextures();

    assert.equal(renderer.originX, -4);
    assert.equal(renderer.originY, -2);
    assert.equal(renderer.width, 8);
    assert.equal(renderer.height, 8);

    renderer.clear();
    renderer.drawTexture(0);
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(renderer, 7, 7), [255, 0, 0, 255]);
});

test('transparent pixels never overwrite existing content', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(4, 4, [255, 0, 0, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.fitToTextures();
    renderer.clear();
    renderer.drawTexture(0);

    const transparent = solidTexture(4, 4, [0, 255, 0, 0]);
    renderer.textures[0] = { ...transparent, hotspotX: 0, hotspotY: 0 };
    renderer.drawTexture(0);

    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);
});

test('opaque blits are idempotent, like anim.c indexed copies', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(4, 4, [10, 20, 30, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.fitToTextures();
    renderer.clear();

    renderer.drawTexture(0);
    const first = Array.from(renderer.buffer);
    renderer.drawTexture(0);
    assert.deepEqual(Array.from(renderer.buffer), first);
});

test('partial alpha is composited', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(2, 2, [0, 0, 0, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.addTexture({ ...solidTexture(2, 2, [255, 255, 255, 128]), hotspotX: 0, hotspotY: 0 });
    renderer.fitToTextures();
    renderer.clear();

    renderer.drawTexture(0);
    renderer.drawTexture(1);

    const [r, g, b, a] = pixel(renderer, 0, 0);
    assert.ok(r > 120 && r < 136, `red channel should be ~127, got ${r}`);
    assert.equal(a, 255, 'compositing onto opaque black stays opaque');
    assert.equal(g, r);
    assert.equal(b, r);
});

test('blitting is clipped to the frame buffer', () => {
    const renderer = new Renderer();
    renderer.width = 4;
    renderer.height = 4;
    renderer.buffer = new Uint8ClampedArray(4 * 4 * 4);
    renderer.textures = [{ ...solidTexture(8, 8, [255, 0, 0, 255]), hotspotX: 0, hotspotY: 0 }];

    // Drawn at (-2, -2): only the bottom-right 4x4 of the sprite is visible.
    renderer.originX = 2;
    renderer.originY = 2;
    assert.equal(renderer.drawTexture(0), true);

    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(renderer, 3, 3), [255, 0, 0, 255]);
});

test('drawTexture rejects unknown indices and present() works without a canvas', () => {
    const renderer = new Renderer();
    renderer.addTexture({ ...solidTexture(2, 2, [1, 2, 3, 255]), hotspotX: 0, hotspotY: 0 });
    renderer.fitToTextures();

    assert.equal(renderer.drawTexture(99), false);
    renderer.present(null);
    renderer.present(undefined);
    assert.equal(renderer.presentCalls, 2, 'headless presentations are still counted');
});
