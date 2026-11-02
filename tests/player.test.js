import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { VM } from 'tzo/vm';

import { AnimPlayer, ensureBraceFunctionNames, runBounded, sanitizeProgramState } from '../src/player.js';
import { Renderer } from '../src/renderer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureProgram = JSON.parse(readFileSync(join(here, 'fixtures', 'sample', 'program.json'), 'utf8'));
const exampleProgram = JSON.parse(readFileSync(join(here, '..', 'public', 'examples', 'chmmr', 'program.json'), 'utf8'));

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

function contentWith(textures) {
    const blobs = new Map();
    for (const [path, value] of Object.entries(textures)) {
        blobs.set(path, Object.assign(new Blob([path]), { name: path }));
    }
    return {
        content: { resolve: async (path) => blobs.get(path) || null },
        decode: async (blob) => textures[blob.name],
    };
}

async function loadFixture(textures = {
    'frame0.png': texture(8, 8, [255, 0, 0]),
    'frame1.png': texture(8, 8, [0, 200, 0]),
}) {
    const renderer = new Renderer();
    const { content, decode } = contentWith(textures);
    const player = new AnimPlayer({ renderer, decode });
    const result = await player.load(fixtureProgram, content);
    return { renderer, player, result };
}

test('loads a program, sizes the canvas and does not draw during init', async () => {
    const { renderer, player, result } = await loadFixture();

    assert.equal(result.textures, 2);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(player.loaded, true);
    assert.equal(player.ticks, 0);

    assert.equal(renderer.width, 12);
    assert.equal(renderer.height, 10);
    assert.equal(renderer.presentCalls, 1, 'the initial (empty) frame is presented once');
    assert.equal(renderer.drawCalls, 0);
    assert.deepEqual(player.context, {
        anim_anim_0_index: 0,
        anim_anim_0_active: 1,
        anim_anim_0_yy_direction: 1,
        anim_anim_0_tick: 0,
    });
});

test('ticks advance the animation every two frames and draw one frame per tick', async () => {
    const { renderer, player } = await loadFixture();

    player.tick();
    assert.equal(player.ticks, 1);
    assert.equal(renderer.drawCalls, 1);
    assert.equal(renderer.presentCalls, 2, 'initial frame + one animation frame');
    assert.equal(player.context.anim_anim_0_index, 0);
    assert.deepEqual(pixel(renderer, 0, 0), [255, 0, 0, 255]);

    player.tick();
    assert.equal(renderer.drawCalls, 2);
    assert.equal(player.context.anim_anim_0_index, 1);

    // Tick 3 draws the second frame; its hotspot (-4,-2) puts it at (4,2).
    player.tick();
    assert.equal(renderer.drawCalls, 3);
    assert.equal(player.context.anim_anim_0_index, 1);
    assert.deepEqual(pixel(renderer, 4, 2), [0, 200, 0, 255], 'frame1 is drawn at its hotspot offset');

    player.tick();
    assert.equal(renderer.drawCalls, 4);
    assert.equal(player.context.anim_anim_0_index, 0);
    assert.equal(renderer.presentCalls, 5);
});

test('missing content files are reported and replaced by placeholders', async () => {
    const renderer = new Renderer();
    const player = new AnimPlayer({ renderer, decode: async () => texture(1, 1, [0, 0, 0]) });
    const result = await player.load(fixtureProgram, { resolve: async () => null });

    assert.deepEqual(result.missing, ['frame0.png', 'frame1.png']);
    assert.equal(result.textures, 2);
    assert.equal(renderer.textures[0].missing, true);
    // Placeholders are 1x1, so the canvas only spans the hotspot offsets.
    assert.equal(renderer.width, 5);
    assert.equal(renderer.height, 3);
    assert.equal(player.tick(), true);
    assert.equal(renderer.presentCalls, 2);
});

test('restart reloads the program from its initial state', async () => {
    const { renderer, player } = await loadFixture();
    player.tick();
    player.tick();
    player.tick();
    assert.equal(player.ticks, 3);

    const result = await player.restart();
    assert.equal(result.textures, 2);
    assert.equal(player.ticks, 0);
    assert.equal(player.context.anim_anim_0_index, 0);
    assert.equal(renderer.presentCalls, 1, 'only the initial empty frame');
    assert.equal(renderer.drawCalls, 0);
});

test('sanitizeProgramState accepts a bare instruction list and resolves label clashes', () => {
    const state = sanitizeProgramState([
        { type: 'invoke-function-instruction', functionName: 'nop', label: 'loop' },
        { type: 'push-string-instruction', value: 'loop' },
        { type: 'invoke-function-instruction', functionName: 'goto' },
    ]);

    assert.equal(state.programList.length, 3);
    assert.deepEqual(state.labelMap, {});
    assert.deepEqual(state.stack, []);
    assert.deepEqual(state.context, {});
    assert.equal(state.programCounter, 0);
    assert.equal(state.exit, false);
    assert.equal(state.pause, false);
});

test('sanitizeProgramState keeps the labelMap when a label is also on an instruction', () => {
    const state = sanitizeProgramState({
        programList: [{ type: 'invoke-function-instruction', functionName: 'nop', label: 'loop' }],
        labelMap: { loop: 0 },
    });
    assert.deepEqual(state.labelMap, { loop: 0 });
    assert.equal(state.programList[0].label, undefined);
});

test('sanitizeProgramState rejects things that are not TZO programs', () => {
    assert.throws(() => sanitizeProgramState({ hello: 'world' }), /not a TZO program/);
    assert.throws(() => sanitizeProgramState({ programList: [{}] }), /Invalid instruction/);
    assert.throws(() => sanitizeProgramState(null), /not a TZO program/);
});

test('runBounded stops programs that never pause', () => {
    const vm = new VM({}, {});
    vm.loadVMState({
        programList: [
            { type: 'invoke-function-instruction', functionName: 'nop' },
            { type: 'push-string-instruction', value: 'loop' },
            { type: 'invoke-function-instruction', functionName: 'goto' },
        ],
        labelMap: { loop: 0 },
        stack: [],
        context: {},
        programCounter: 0,
        exit: false,
        pause: false,
    });

    const result = runBounded(vm, 100);
    assert.equal(result.limited, true);
    assert.equal(result.paused, false);
    assert.ok(result.instructions > 100);
});

test('the bundled chmmr example loads and plays on the official VM', async () => {
    const renderer = new Renderer();
    const player = new AnimPlayer({
        renderer,
        decode: async () => texture(1, 1, [10, 20, 30]),
    });

    const result = await player.load(exampleProgram, { resolve: async () => new Blob(['image']) });

    assert.equal(result.textures, 85);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(player.state.programList.length, 1767);

    const drawCallsBefore = renderer.drawCalls;
    player.tick();
    assert.equal(renderer.drawCalls - drawCallsBefore, 8, 'background + 7 animations are drawn per tick');

    const indicesBefore = [1, 2, 3, 4, 5, 6, 7].map((id) => player.context[`anim_anim_${id}_index`]);
    for (let i = 0; i < 4; i++) {
        player.tick();
    }
    const indicesAfter = [1, 2, 3, 4, 5, 6, 7].map((id) => player.context[`anim_anim_${id}_index`]);
    assert.notDeepEqual(indicesAfter, indicesBefore, 'animations advance');
    assert.equal(player.context.anim_anim_0_index, 0, 'the background never advances');
});

test('brace opcode names are restored for bundled builds', () => {
    // A tiny program with an if-block that is *not* entered: `if (0) { nop }`.
    // A false condition means the `{` opcode itself runs and has to find the
    // matching `}` by function name.
    const state = {
        programList: [
            { type: 'push-number-instruction', value: 0 },
            { type: 'invoke-function-instruction', functionName: 'jgz' },
            { type: 'invoke-function-instruction', functionName: '{' },
            { type: 'invoke-function-instruction', functionName: 'nop' },
            { type: 'invoke-function-instruction', functionName: '}' },
            { type: 'invoke-function-instruction', functionName: 'pause' },
        ],
        labelMap: {},
        stack: [],
        context: {},
        programCounter: 0,
        exit: false,
        pause: false,
    };

    // Simulate what Vite/esbuild does to the opcode functions.
    const rename = (vm) => {
        for (const fn of vm.programList) {
            if (fn.name === 'openBrace') {
                Object.defineProperty(fn, 'name', { value: 'openBrace2', configurable: true });
            }
            if (fn.name === 'closeBrace') {
                Object.defineProperty(fn, 'name', { value: 'closeBrace2', configurable: true });
            }
        }
    };

    const broken = new VM({}, {});
    broken.loadVMState(JSON.parse(JSON.stringify(state)));
    rename(broken);
    assert.throws(() => runBounded(broken, 1000), /Cannot read properties of undefined/);

    // The player restores the names, so the same program runs fine.
    const fixed = new VM({}, {});
    fixed.loadVMState(JSON.parse(JSON.stringify(state)));
    rename(fixed);
    ensureBraceFunctionNames(fixed, state.programList);
    const result = runBounded(fixed, 1000);
    assert.equal(result.paused, true);
    assert.equal(fixed.programCounter, 6, 'the if-block was entered and the program paused at the end');
});
