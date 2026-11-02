/*
 * End-to-end smoke test, driven over the Chrome DevTools Protocol.
 *
 * Usage:
 *   npm run dev &                     # or: npm run build && npx vite preview --port 5173
 *   node tests/browser-check.mjs http://localhost:5173/ [--screenshots=dir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean);

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => !arg.startsWith('--')) || 'http://localhost:5173/';
const screenshotArg = args.find((arg) => arg.startsWith('--screenshots='));
const screenshotDir = screenshotArg ? screenshotArg.split('=')[1] : null;

let failures = 0;

function check(name, condition, detail = '') {
    if (!condition) {
        failures++;
    }
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    reject(new Error(message.error.message));
                } else {
                    resolve(message.result);
                }
                return;
            }
            for (const handler of this.listeners.get(message.method) || []) {
                handler(message.params);
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    once(method) {
        return new Promise((resolve) => {
            const handler = (params) => {
                const list = this.listeners.get(method) || [];
                this.listeners.set(method, list.filter((entry) => entry !== handler));
                resolve(params);
            };
            const list = this.listeners.get(method) || [];
            list.push(handler);
            this.listeners.set(method, list);
        });
    }
}

async function findChrome() {
    const { accessSync, constants } = await import('node:fs');
    for (const candidate of CHROME_CANDIDATES) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            /* try next */
        }
    }
    throw new Error('Chrome/Chromium not found; set CHROME=/path/to/chrome');
}

async function waitForDevTools(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (response.ok) {
                const targets = await response.json();
                const page = targets.find((target) => target.type === 'page');
                if (page) {
                    return page.webSocketDebuggerUrl;
                }
            }
        } catch {
            /* not up yet */
        }
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for Chrome');
        }
        await sleep(150);
    }
}

async function main() {
    const chromePath = await findChrome();
    const port = 9521 + Math.floor(Math.random() * 200);
    const userDataDir = mkdtempSync(join(tmpdir(), 'tzo-anim-chrome-'));
    if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
    }

    const chrome = spawn(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--window-size=1440,900',
        'about:blank',
    ], { stdio: 'ignore' });

    let cdp;
    try {
        const socket = new WebSocket(await waitForDevTools(port));
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        cdp = new CDP(socket);

        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });

        const errors = [];
        cdp.listeners.set('Runtime.exceptionThrown', [(params) => {
            errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
        }]);
        cdp.listeners.set('Log.entryAdded', [(params) => {
            if (params.entry.level === 'error') {
                errors.push(params.entry.text);
            }
        }]);

        const evaluate = async (expression) => {
            const response = await cdp.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });
            if (response.exceptionDetails) {
                throw new Error(response.exceptionDetails.exception?.description
                    || response.exceptionDetails.text
                    || 'evaluation failed');
            }
            return response.result.value;
        };

        const waitFor = async (expression, timeoutMs = 30000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                try {
                    if (await evaluate(expression)) {
                        return true;
                    }
                } catch {
                    /* still booting */
                }
                if (Date.now() > deadline) {
                    return false;
                }
                await sleep(100);
            }
        };

        const capture = async (name) => {
            if (!screenshotDir) {
                return;
            }
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(screenshotDir, name), Buffer.from(data, 'base64'));
        };

        /* ------------------------------------------------------------ */
        /* Boot + bundled example                                        */
        /* ------------------------------------------------------------ */
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: `${baseUrl}?example=chmmr` });
        await loaded;

        check('app boots', await waitFor('Boolean(window.tzoAnimApp)'));
        check('example program loads', await waitFor('window.tzoAnimApp.player.loaded && window.tzoAnimApp.renderer.textures.length === 85'));

        const info = await evaluate(`(() => {
            const app = window.tzoAnimApp;
            const buffer = app.renderer.buffer;
            let opaque = 0;
            for (let index = 3; index < buffer.length; index += 4) {
                if (buffer[index] > 0) opaque++;
            }
            return {
                textures: app.renderer.textures.length,
                width: app.renderer.width,
                height: app.renderer.height,
                canvasWidth: document.getElementById('screen').width,
                canvasHeight: document.getElementById('screen').height,
                draws: app.renderer.drawCalls,
                presents: app.renderer.presentCalls,
                ticks: app.player.ticks,
                opaquePixels: opaque,
                animRows: document.querySelectorAll('#animTableBody tr').length,
                factTextures: document.getElementById('factTextures').textContent,
                factInstructions: document.getElementById('factInstructions').textContent,
                status: document.getElementById('statusText').textContent,
            };
        })()`);

        check('85 textures loaded and the canvas is sized from the hotspots',
            info.textures === 85 && info.width > 200 && info.height > 80 && info.canvasWidth === info.width,
            JSON.stringify({ size: `${info.width}x${info.height}`, canvas: `${info.canvasWidth}x${info.canvasHeight}` }));
        check('frames are drawn and presented',
            info.draws > 0 && info.presents > 0 && info.opaquePixels > 1000,
            JSON.stringify({ draws: info.draws, presents: info.presents, opaquePixels: info.opaquePixels }));
        check('animation state table shows the 8 animations', info.animRows === 8, `rows=${info.animRows}`);
        check('program facts are filled in',
            info.factTextures === '85' && info.factInstructions === '1767',
            JSON.stringify({ textures: info.factTextures, instructions: info.factInstructions }));

        const ticksBefore = info.ticks;
        await sleep(800);
        const ticksAfter = await evaluate('window.tzoAnimApp.player.ticks');
        check('the animation keeps ticking', ticksAfter > ticksBefore, `${ticksBefore} -> ${ticksAfter}`);

        /* ------------------------------------------------------------ */
        /* Pause / step / restart                                        */
        /* ------------------------------------------------------------ */
        const transport = await evaluate(`(async () => {
            const app = window.tzoAnimApp;
            document.getElementById('playBtn').click();
            const pausedTicks = app.player.ticks;
            await new Promise((resolve) => setTimeout(resolve, 300));
            const stillPaused = app.player.ticks === pausedTicks;
            document.getElementById('stepBtn').click();
            const afterStep = app.player.ticks;
            document.getElementById('restartBtn').click();
            await new Promise((resolve) => setTimeout(resolve, 400));
            return {
                paused: stillPaused,
                stepped: afterStep === pausedTicks + 1,
                restarted: app.player.ticks < afterStep + 20,
                label: document.getElementById('playLabel').textContent,
            };
        })()`);
        check('pause, step and restart work',
            transport.paused && transport.stepped && transport.restarted,
            JSON.stringify(transport));

        /* ------------------------------------------------------------ */
        /* Loading a .zip                                                */
        /* ------------------------------------------------------------ */
        const zip = await evaluate(`(async () => {
            const response = await fetch('tests/fixtures/sample.zip');
            if (!response.ok) {
                throw new Error('could not fetch the fixture zip: ' + response.status);
            }
            const blob = await response.blob();
            await window.tzoAnimApp.openZipBlob(blob);
            await new Promise((resolve) => setTimeout(resolve, 500));
            const app = window.tzoAnimApp;
            return {
                loaded: app.player.loaded,
                textures: app.renderer.textures.length,
                width: app.renderer.width,
                height: app.renderer.height,
                instructions: app.player.state.programList.length,
                index: app.player.context.anim_anim_0_index,
                animRows: document.querySelectorAll('#animTableBody tr').length,
            };
        })()`);
        check('a .zip with a program and content files loads and plays',
            zip.loaded && zip.textures === 2 && zip.width === 12 && zip.height === 10 && zip.animRows === 1,
            JSON.stringify(zip));

        const zipTicks = await evaluate(`(async () => {
            const before = window.tzoAnimApp.player.ticks;
            const indexBefore = window.tzoAnimApp.player.context.anim_anim_0_index;
            await new Promise((resolve) => setTimeout(resolve, 500));
            return {
                ticks: window.tzoAnimApp.player.ticks - before,
                indexChanged: window.tzoAnimApp.player.context.anim_anim_0_index !== indexBefore,
            };
        })()`);
        check('the zipped program animates', zipTicks.ticks > 5 && zipTicks.indexChanged, JSON.stringify(zipTicks));

        await capture('app-zip.png');

        /* ------------------------------------------------------------ */
        /* Screenshots                                                   */
        /* ------------------------------------------------------------ */
        if (screenshotDir) {
            await evaluate(`(async () => {
                await window.tzoAnimApp.loadExample();
                return true;
            })()`);
            await sleep(1200);
            await capture('app-dark.png');

            await evaluate(`(() => {
                document.getElementById('themeBtn').click();
                return true;
            })()`);
            await sleep(400);
            await capture('app-light.png');

            await evaluate(`(() => {
                document.getElementById('themeBtn').click();
                return true;
            })()`);

            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 430,
                height: 900,
                deviceScaleFactor: 1,
                mobile: true,
            });
            await sleep(500);
            await capture('app-mobile.png');
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 1440,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
            });

            const reloaded = cdp.once('Page.loadEventFired');
            await cdp.send('Page.navigate', { url: baseUrl });
            await reloaded;
            await sleep(600);
            await capture('app-empty.png');
        }

        check('no uncaught page errors', errors.length === 0, errors.join(' | '));

        console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
    } finally {
        try {
            if (cdp) {
                await cdp.send('Browser.close').catch(() => {});
            }
        } catch {
            /* ignore */
        }
        chrome.kill('SIGKILL');
        await sleep(300);
        try {
            rmSync(userDataDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }

    if (failures > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
