/*
 * AnimPlayer — hosts a TZO animation program on the official TZO virtual
 * machine (the `tzo` npm package) and feeds it to the Renderer.
 *
 * The animation extension is the one implemented by tzo-c's anim.c:
 *
 *   loadImage(hotspotY, hotspotX, path)  -> assigns the next texture index
 *   drawFrame(textureIndex)              -> blits that texture
 *   beginDraw() / endDraw()              -> frame brackets (endDraw presents)
 *
 * Loading happens in two phases, like anim.c's two run() calls:
 *   1. run the program with a recording loadImage to discover which images are
 *      needed (the init phase ends in a `pause`),
 *   2. decode those images, then run the program for real so loadImage can hand
 *      out textures synchronously.
 */

import { VM } from 'tzo/vm';

const MAX_INSTRUCTIONS_PER_INIT = 500_000;
const MAX_INSTRUCTIONS_PER_TICK = 5_000_000;
const DECODE_CONCURRENCY = 6;

/**
 * Normalise a parsed JSON program into a valid TZO VM state.
 * Accepts both the "VM state" representation (tzo-c's yehat.json) and a plain
 * instruction array.
 */
export function sanitizeProgramState(raw) {
    if (Array.isArray(raw)) {
        raw = { programList: raw };
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.programList)) {
        throw new Error('This JSON file is not a TZO program (missing "programList").');
    }

    const programList = raw.programList.map((instruction, index) => {
        if (!instruction || typeof instruction !== 'object' || typeof instruction.type !== 'string') {
            throw new Error(`Invalid instruction at index ${index}.`);
        }
        return { ...instruction };
    });

    const labelMap = { ...(raw.labelMap || {}) };

    // The reference VM throws when a label is both in the labelMap and on an
    // instruction, so let the labelMap win (it is what the C implementation uses).
    for (const instruction of programList) {
        if (instruction.label !== undefined && labelMap[instruction.label] !== undefined) {
            delete instruction.label;
        }
    }

    return {
        programList,
        labelMap,
        stack: Array.isArray(raw.stack) ? [...raw.stack] : [],
        context: raw.context && typeof raw.context === 'object' ? { ...raw.context } : {},
        programCounter: Number.isInteger(raw.programCounter) ? raw.programCounter : 0,
        exit: Boolean(raw.exit),
        pause: Boolean(raw.pause),
    };
}

/**
 * The reference TZO VM implements the `{` opcode by scanning the program list
 * for the function whose `.name` is "openBrace" (and likewise "closeBrace").
 * Bundlers rename those functions (Vite's esbuild pre-bundling turns them into
 * `openBrace2`), which makes every `if` block scan past the end of the program.
 * Restore the names on the functions the VM actually uses.
 *
 * @param {VM} vm a VM that has just loaded a program
 * @param {Array} programList the program list that was loaded
 */
export function ensureBraceFunctionNames(vm, programList) {
    const replacements = new Map();

    for (let index = 0; index < programList.length; index++) {
        const functionName = programList[index] && programList[index].functionName;
        const expected = functionName === '{' ? 'openBrace' : functionName === '}' ? 'closeBrace' : null;
        if (!expected) {
            continue;
        }

        const original = vm.programList[index];
        if (typeof original !== 'function' || original.name === expected) {
            continue;
        }

        let fixed = replacements.get(original);
        if (!fixed) {
            fixed = original;
            try {
                Object.defineProperty(fixed, 'name', { value: expected, configurable: true });
            } catch (error) {
                // Frozen function object: wrap it so the name is right.
                fixed = {
                    [expected]: function braceOpcode(stack, context, innerVm) {
                        return original(stack, context, innerVm);
                    },
                }[expected];
            }
            replacements.set(original, fixed);
        }
        vm.programList[index] = fixed;
    }
}

function cloneState(state) {
    return {
        programList: state.programList.map((instruction) => ({ ...instruction })),
        labelMap: { ...state.labelMap },
        stack: [...state.stack],
        context: { ...state.context },
        programCounter: state.programCounter,
        exit: state.exit,
        pause: state.pause,
    };
}

/**
 * Run until the VM pauses/exits, but never execute more than `limit`
 * instructions (protects the UI from programs that never pause).
 */
export function runBounded(vm, limit) {
    vm.pause = false;
    let instructions = 0;
    while (!vm.exit && !vm.pause) {
        vm.tick();
        instructions++;
        if (instructions > limit) {
            return { instructions, paused: false, limited: true, exited: vm.exit };
        }
    }
    return { instructions, paused: Boolean(vm.pause), limited: false, exited: Boolean(vm.exit) };
}

async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

export class AnimPlayer {
    /**
     * @param {object} options
     * @param {import('./renderer.js').Renderer} options.renderer
     * @param {(blob: Blob) => Promise<{width:number,height:number,data:Uint8ClampedArray}>} options.decode
     * @param {HTMLCanvasElement|null} [options.canvas]
     */
    constructor({ renderer, decode, canvas = null, onFrame = null, onError = null, onProgress = null } = {}) {
        if (!renderer) {
            throw new Error('AnimPlayer requires a renderer.');
        }
        if (typeof decode !== 'function') {
            throw new Error('AnimPlayer requires a decode function.');
        }

        this.renderer = renderer;
        this.decode = decode;
        this.canvas = canvas;
        this.onFrame = onFrame;
        this.onError = onError;
        this.onProgress = onProgress;

        this.vm = null;
        this.state = null;
        this.content = null;
        this.textures = [];
        this.ticks = 0;
        this.warnings = [];
        this.decodeCache = new Map();
        this.loading = false;
    }

    get loaded() {
        return this.vm !== null;
    }

    get context() {
        return this.vm ? this.vm.context : {};
    }

    /**
     * @param {object} rawState parsed JSON program
     * @param {{resolve: (path: string) => Promise<Blob|null>}} content
     * @returns {Promise<{textures: number, missing: string[], warnings: string[]}>}
     */
    async load(rawState, content) {
        this.loading = true;
        this.vm = null;
        this.textures = [];
        this.ticks = 0;
        this.warnings = [];
        this.state = sanitizeProgramState(rawState);
        this.content = content;
        this.renderer.reset();

        try {
            // Phase 1: discover the images the program asks for.
            const requests = [];
            const collector = new VM({}, {
                loadImage: (stack) => {
                    const path = stack.pop();
                    const hotspotX = stack.pop();
                    const hotspotY = stack.pop();
                    requests.push({ path, hotspotX, hotspotY });
                },
                beginDraw: () => {},
                endDraw: () => {},
                drawFrame: (stack) => {
                    stack.pop();
                },
            });
            collector.loadVMState(cloneState(this.state));
            ensureBraceFunctionNames(collector, this.state.programList);
            const init = runBounded(collector, MAX_INSTRUCTIONS_PER_INIT);
            if (!init.paused && !init.exited) {
                this.warnings.push(
                    'The program did not pause during its initialisation; textures are collected from the '
                    + 'instructions that ran. Images loaded later cannot be preloaded.',
                );
            }

            // Phase 2: decode the images.
            let decodedCount = 0;
            const decoded = await mapLimit(requests, DECODE_CONCURRENCY, async (request) => {
                let bitmap = null;
                let blob = null;
                try {
                    blob = await content.resolve(request.path);
                } catch (error) {
                    blob = null;
                }
                if (blob) {
                    bitmap = this.decodeCache.get(blob) || null;
                    if (!bitmap) {
                        try {
                            bitmap = await this.decode(blob);
                            this.decodeCache.set(blob, bitmap);
                        } catch (error) {
                            bitmap = null;
                        }
                    }
                }
                decodedCount++;
                this.onProgress?.({
                    done: decodedCount,
                    total: requests.length,
                    path: request.path,
                    ok: Boolean(bitmap),
                });
                return bitmap;
            });

            const missing = requests.filter((request, index) => !decoded[index]).map((request) => request.path);

            // Phase 3: run the program for real.
            let textureIndex = 0;
            const vm = new VM({}, {
                loadImage: (stack) => {
                    const path = stack.pop();
                    const hotspotX = stack.pop();
                    const hotspotY = stack.pop();
                    const bitmap = decoded[textureIndex];
                    if (!bitmap) {
                        this.warnings.push(`Texture ${textureIndex} (${path}) has no image; a 1x1 placeholder is used.`);
                    }
                    const texture = {
                        width: bitmap ? bitmap.width : 1,
                        height: bitmap ? bitmap.height : 1,
                        data: bitmap ? bitmap.data : new Uint8ClampedArray([0, 0, 0, 0]),
                        hotspotX,
                        hotspotY,
                        path,
                        missing: !bitmap,
                    };
                    this.textures.push(texture);
                    this.renderer.addTexture(texture);
                    textureIndex++;
                },
                beginDraw: () => {},
                endDraw: () => {
                    this.renderer.present(this.canvas);
                    this.onFrame?.();
                },
                drawFrame: (stack) => {
                    const index = stack.pop();
                    if (!this.renderer.drawTexture(index)) {
                        throw new Error(`drawFrame(${index}): that texture has not been loaded.`);
                    }
                },
            });

            vm.loadVMState(cloneState(this.state));
            ensureBraceFunctionNames(vm, this.state.programList);
            runBounded(vm, MAX_INSTRUCTIONS_PER_INIT);

            this.vm = vm;
            this.renderer.fitToTextures();
            this.renderer.clear();
            this.renderer.present(this.canvas);

            return {
                textures: this.textures.length,
                missing,
                warnings: [...this.warnings],
            };
        } finally {
            this.loading = false;
        }
    }

    /** Run one animation tick (until the program pauses again). */
    tick() {
        if (!this.vm) {
            return false;
        }
        try {
            const result = runBounded(this.vm, MAX_INSTRUCTIONS_PER_TICK);
            this.ticks++;
            if (result.limited) {
                this.warnings.push('The program did not pause within the instruction budget for one tick.');
            }
            if (result.exited) {
                this.onError?.(new Error('The program called exit.'));
            }
            return true;
        } catch (error) {
            this.onError?.(error);
            return false;
        }
    }

    /** Reload the current program from its initial state. */
    async restart() {
        if (!this.state || !this.content) {
            return null;
        }
        return this.load(this.state, this.content);
    }
}
