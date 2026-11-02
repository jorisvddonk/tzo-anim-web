/*
 * tzo-anim web player — UI wiring.
 */

import { Renderer } from './renderer.js';
import { AnimPlayer } from './player.js';
import {
    ContentStore,
    entriesFromDirectoryHandle,
    projectFromDirectoryHandle,
    projectFromEntries,
    projectFromFiles,
    projectFromZip,
} from './content.js';

const SETTINGS_KEY = 'tzo-anim-web.settings.v1';

const $ = (id) => document.getElementById(id);

const els = {
    stage: $('stage'),
    screen: $('screen'),
    playBtn: $('playBtn'),
    playIcon: $('playIcon'),
    playLabel: $('playLabel'),
    stepBtn: $('stepBtn'),
    restartBtn: $('restartBtn'),
    speedInput: $('speedInput'),
    speedValue: $('speedValue'),
    zoomInput: $('zoomInput'),
    tickCount: $('tickCount'),
    factStatus: $('factStatus'),
    factSource: $('factSource'),
    factInstructions: $('factInstructions'),
    factTextures: $('factTextures'),
    factAnimations: $('factAnimations'),
    factCanvas: $('factCanvas'),
    animTableBody: $('animTableBody'),
    animHint: $('animHint'),
    contextCount: $('contextCount'),
    contextPre: $('contextPre'),
    log: $('log'),
    statusText: $('statusText'),
    statusRate: $('statusRate'),
    dropOverlay: $('dropOverlay'),
    themeBtn: $('themeBtn'),
    dialogBackdrop: $('dialogBackdrop'),
    dialogTitle: $('dialogTitle'),
    dialogBody: $('dialogBody'),
    dialogCancel: $('dialogCancel'),
};

const app = {
    project: null,
    program: null,
    playing: false,
    ticksPerSecond: 30,
    zoom: '2',
    rateSamples: [],
    lastInspectorUpdate: 0,
    settings: loadSettings(),
};

/* ------------------------------------------------------------------ */
/* Renderer + player                                                   */
/* ------------------------------------------------------------------ */

const renderer = new Renderer();

const player = new AnimPlayer({
    renderer,
    decode: decodeImage,
    canvas: els.screen,
    onError: (error) => {
        log(`VM error: ${error.message}`, 'error');
        setPlaying(false);
        setStatus(`VM error: ${error.message}`);
    },
    onProgress: ({ done, total, path, ok }) => {
        setStatus(`Loading textures ${done}/${total}…`);
        if (!ok) {
            log(`missing content file: ${path}`, 'warn');
        }
    },
});

/* ------------------------------------------------------------------ */
/* Image decoding                                                      */
/* ------------------------------------------------------------------ */

async function decodeImage(blob) {
    let source;
    try {
        source = await createImageBitmap(blob);
    } catch (error) {
        source = await decodeWithImageElement(blob);
    }

    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0);
    const imageData = context.getImageData(0, 0, width, height);
    source.close?.();
    return { width, height, data: imageData.data };
}

function decodeWithImageElement(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('could not decode image'));
        };
        image.src = url;
    });
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        if (accept) {
            input.accept = accept;
        }
        if (directory) {
            input.webkitdirectory = true;
        }
        input.style.display = 'none';
        document.body.appendChild(input);

        let settled = false;
        const done = (files) => {
            if (settled) {
                return;
            }
            settled = true;
            input.remove();
            resolve(files);
        };
        input.addEventListener('change', () => done(Array.from(input.files || [])));
        input.addEventListener('cancel', () => done([]));
        input.click();
    });
}

async function openFolder() {
    if (typeof window.showDirectoryPicker === 'function') {
        let handle = null;
        try {
            handle = await window.showDirectoryPicker({ id: 'tzo-anim', mode: 'read' });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            log(`Folder picker failed (${error.message}); using a file input instead.`, 'warn');
        }
        if (handle) {
            await loadProject(await projectFromDirectoryHandle(handle));
            return;
        }
    }

    const files = await pickFiles({ directory: true, multiple: true });
    if (files.length > 0) {
        await loadProject(await projectFromFiles(files));
    }
}

async function openZip() {
    const files = await pickFiles({ accept: '.zip,application/zip', multiple: false });
    if (files.length === 0) {
        return;
    }
    await loadProject(await projectFromZip(files[0]));
}

/**
 * Open a program .json, then optionally a folder with its content files
 * ("load a json + folder").
 */
async function openProgram() {
    const files = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (files.length === 0) {
        return;
    }
    const programFile = files[0];
    const entries = [{ path: programFile.name, blob: programFile }];

    setStatus('Pick the folder that contains the content files (cancel to skip)…');
    if (typeof window.showDirectoryPicker === 'function') {
        try {
            const handle = await window.showDirectoryPicker({ id: 'tzo-anim-content', mode: 'read' });
            if (handle) {
                const contentEntries = await entriesFromDirectoryHandle(handle);
                entries.push(...contentEntries);
                log(`Added ${contentEntries.length} content file(s) from ${handle.name}.`);
            }
        } catch (error) {
            if (error && error.name !== 'AbortError') {
                log(`Could not read that folder: ${error.message}`, 'warn');
            }
        }
    } else {
        const contentFiles = await pickFiles({ directory: true, multiple: true });
        for (const file of contentFiles) {
            entries.push({ path: file.webkitRelativePath || file.name, blob: file });
        }
    }

    await loadProject(await projectFromEntries(entries, programFile.name));
}

async function loadExample() {
    const baseUrl = new URL('examples/chmmr/', document.baseURI);
    setStatus('Loading the example…');
    try {
        const response = await fetch(new URL('program.json', baseUrl));
        if (!response.ok) {
            throw new Error(`could not fetch the example program (HTTP ${response.status})`);
        }
        const state = await response.json();
        const store = new ContentStore([], { baseUrl });
        await loadProject({
            label: 'examples/chmmr/program.json',
            store,
            programs: [{ name: 'program.json', state, instructions: state.programList.length }],
        });
    } catch (error) {
        console.error(error);
        log(`Could not load the example: ${error.message}`, 'error');
        setStatus(`Could not load the example: ${error.message}`);
    }
}

async function loadProject(project) {
    setPlaying(false);
    app.project = project;
    app.program = null;

    let program = project.programs[0];
    if (project.programs.length > 1) {
        program = await chooseProgram(project.programs);
        if (!program) {
            return;
        }
    }

    await loadProgram(program);
}

async function loadProgram(program) {
    app.program = program;
    els.factStatus.textContent = 'loading…';
    setStatus(`Loading ${program.name}…`);
    log(`Loading ${program.name} (${program.state.programList?.length ?? 0} instructions)`, 'good');

    try {
        const result = await player.load(program.state, app.project.store);

        app.rateSamples = [];
        els.stage.classList.add('has-program');
        els.screen.classList.remove('is-empty');
        enableControls(true);
        updateFacts(result);
        applyZoom();
        updateInspector();
        updateTickCounter(performance.now(), false);

        for (const warning of result.warnings || []) {
            log(warning, 'warn');
        }
        if (result.missing.length > 0) {
            log(`${result.missing.length} content file(s) missing — placeholders are drawn instead.`, 'warn');
            for (const path of result.missing.slice(0, 8)) {
                log(`  missing: ${path}`, 'warn');
            }
        }

        setStatus(`${program.name} — ${player.state.programList.length} instructions, ${result.textures} textures`);
        log(`Loaded ${result.textures} textures, canvas ${renderer.width}×${renderer.height}.`, 'good');
        setPlaying(true);
    } catch (error) {
        console.error(error);
        els.factStatus.textContent = 'error';
        log(`Failed to load: ${error.message}`, 'error');
        setStatus(`Failed to load: ${error.message}`);
        enableControls(false);
        els.stage.classList.remove('has-program');
        els.screen.classList.add('is-empty');
    }
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

let rafId = null;
let lastTime = 0;
let accumulator = 0;

function setPlaying(playing) {
    const next = Boolean(playing) && player.loaded;
    app.playing = next;
    els.playLabel.textContent = next ? 'Pause' : 'Play';
    els.playIcon.textContent = next ? '⏸' : '▶';
    els.factStatus.textContent = player.loaded ? (next ? 'playing' : 'paused') : 'no program loaded';

    if (next) {
        lastTime = 0;
        accumulator = 0;
        if (!rafId) {
            rafId = requestAnimationFrame(loop);
        }
    } else if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}

function loop(now) {
    rafId = null;
    if (!app.playing) {
        return;
    }
    if (!lastTime) {
        lastTime = now;
    }
    const delta = Math.min(now - lastTime, 250);
    lastTime = now;
    accumulator += delta;

    const interval = 1000 / Math.max(1, app.ticksPerSecond);
    let ticks = 0;
    while (accumulator >= interval && ticks < 10) {
        accumulator -= interval;
        player.tick();
        ticks++;
        updateTickCounter(now);
    }

    if (now - app.lastInspectorUpdate > 100) {
        app.lastInspectorUpdate = now;
        updateInspector();
    }

    rafId = requestAnimationFrame(loop);
}

function stepOnce() {
    setPlaying(false);
    player.tick();
    updateTickCounter(performance.now());
    updateInspector();
}

async function restart() {
    if (!player.loaded) {
        return;
    }
    setPlaying(false);
    const result = await player.restart();
    if (!result) {
        return;
    }
    app.rateSamples = [];
    updateFacts(result);
    applyZoom();
    updateInspector();
    updateTickCounter(performance.now(), false);
    setStatus('Program restarted.');
    setPlaying(true);
}

function updateTickCounter(now, sample = true) {
    els.tickCount.textContent = String(player.ticks);
    if (!sample) {
        els.statusRate.textContent = '—';
        return;
    }
    app.rateSamples.push(now);
    while (app.rateSamples.length > 0 && now - app.rateSamples[0] > 1000) {
        app.rateSamples.shift();
    }
    els.statusRate.textContent = `${app.rateSamples.length} ticks/s`;
}

/* ------------------------------------------------------------------ */
/* Inspector                                                           */
/* ------------------------------------------------------------------ */

function collectAnimations(context) {
    const animations = new Map();
    for (const [key, value] of Object.entries(context)) {
        const match = /^anim_anim_(\d+)_(index|active|yy_direction|tick|step)$/.exec(key);
        if (!match) {
            continue;
        }
        const id = Number(match[1]);
        if (!animations.has(id)) {
            animations.set(id, {});
        }
        animations.get(id)[match[2]] = value;
    }
    return new Map([...animations.entries()].sort((a, b) => a[0] - b[0]));
}

function updateInspector() {
    const context = player.context || {};
    const animations = collectAnimations(context);

    const rows = [];
    for (const [id, data] of animations) {
        const row = document.createElement('tr');
        if (data.active === 1) {
            row.classList.add('active');
        } else if (data.active === 0) {
            row.classList.add('stopped');
        }
        const values = [
            `#${id}`,
            data.index ?? '—',
            data.active ?? '—',
            data.yy_direction ?? '—',
            data.tick ?? '—',
        ];
        for (const value of values) {
            const cell = document.createElement('td');
            cell.textContent = String(value);
            row.appendChild(cell);
        }
        rows.push(row);
    }

    if (rows.length === 0) {
        const row = document.createElement('tr');
        row.className = 'empty-row';
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = player.loaded
            ? 'This program does not use the anim_anim_* animation state.'
            : 'No program loaded.';
        row.appendChild(cell);
        rows.push(row);
    }

    els.animTableBody.replaceChildren(...rows);
    els.animHint.hidden = animations.size > 0;

    els.contextCount.textContent = String(Object.keys(context).length);
    els.contextPre.textContent = JSON.stringify(context, null, 2);
}

function updateFacts(result) {
    const state = player.state;
    els.factStatus.textContent = 'paused';
    els.factSource.textContent = app.project?.label || app.program?.name || '—';
    els.factInstructions.textContent = String(state ? state.programList.length : '—');
    els.factTextures.textContent = String(result ? result.textures : renderer.textures.length);
    els.factAnimations.textContent = String(collectAnimations(player.context).size);
    els.factCanvas.textContent = renderer.width ? `${renderer.width}×${renderer.height}` : '—';
}

function enableControls(enabled) {
    els.playBtn.disabled = !enabled;
    els.stepBtn.disabled = !enabled;
    els.restartBtn.disabled = !enabled;
    els.speedInput.disabled = !enabled;
    els.zoomInput.disabled = !enabled;
}

/* ------------------------------------------------------------------ */
/* Zoom / theme / status / log                                         */
/* ------------------------------------------------------------------ */

function applyZoom() {
    if (!renderer.width || !renderer.height) {
        return;
    }
    let scale;
    if (app.zoom === 'fit') {
        const rect = els.stage.getBoundingClientRect();
        const availableWidth = Math.max(64, rect.width - 48);
        const availableHeight = Math.max(64, rect.height - 48);
        const available = Math.min(availableWidth / renderer.width, availableHeight / renderer.height);
        // Whole-number scaling keeps pixel art crisp; below 2x use the exact
        // fit so small screens still use their space.
        scale = available >= 2 ? Math.floor(available) : Math.max(1, available);
    } else {
        scale = Number(app.zoom) || 1;
    }
    els.screen.style.width = `${renderer.width * scale}px`;
    els.screen.style.height = `${renderer.height * scale}px`;
}

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.themeBtn.textContent = theme === 'dark' ? '🌙' : '☀️';
    els.themeBtn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function setStatus(text) {
    els.statusText.textContent = text;
}

function log(message, level = 'info') {
    const item = document.createElement('li');
    item.className = `log-${level}`;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    item.textContent = `${time}  ${message}`;
    els.log.appendChild(item);
    while (els.log.children.length > 200) {
        els.log.removeChild(els.log.firstChild);
    }
    els.log.scrollTop = els.log.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Program chooser                                                     */
/* ------------------------------------------------------------------ */

function chooseProgram(programs) {
    return new Promise((resolve) => {
        els.dialogTitle.textContent = 'Choose a program';
        els.dialogBody.replaceChildren(...programs.map((program) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dialog-item';
            const name = document.createElement('span');
            name.className = 'dialog-item-name';
            name.textContent = program.name;
            const meta = document.createElement('span');
            meta.className = 'dialog-item-meta';
            meta.textContent = `${program.instructions ?? program.state.programList.length} instructions`;
            button.append(name, meta);
            button.addEventListener('click', () => {
                els.dialogBackdrop.hidden = true;
                resolve(program);
            });
            return button;
        }));
        els.dialogBackdrop.hidden = false;
        els.dialogCancel.onclick = () => {
            els.dialogBackdrop.hidden = true;
            resolve(null);
        };
    });
}

/* ------------------------------------------------------------------ */
/* Drag & drop                                                         */
/* ------------------------------------------------------------------ */

async function entriesFromDataTransfer(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    const roots = [];

    for (const item of items) {
        if (item.kind !== 'file') {
            continue;
        }
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
            roots.push(entry);
        } else {
            const file = item.getAsFile();
            if (file) {
                roots.push({ isFile: true, isDirectory: false, name: file.name, file });
            }
        }
    }

    if (roots.length === 0) {
        for (const file of Array.from(dataTransfer.files || [])) {
            roots.push({ isFile: true, isDirectory: false, name: file.name, file });
        }
    }

    const out = [];
    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            const file = entry.file
                ? entry.file
                : await new Promise((resolve, reject) => entry.file(resolve, reject));
            out.push({ path: prefix ? `${prefix}${file.name}` : file.name, blob: file });
            return;
        }
        if (entry.isDirectory) {
            const reader = entry.createReader();
            const path = prefix ? `${prefix}${entry.name}/` : `${entry.name}/`;
            for (;;) {
                const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (children.length === 0) {
                    break;
                }
                for (const child of children) {
                    await walk(child, path);
                }
            }
        }
    };

    for (const root of roots) {
        await walk(root, '');
    }
    return out;
}

async function handleDrop(dataTransfer) {
    setStatus('Reading dropped files…');
    let entries;
    try {
        entries = await entriesFromDataTransfer(dataTransfer);
    } catch (error) {
        log(`Could not read the dropped files: ${error.message}`, 'error');
        return;
    }
    if (entries.length === 0) {
        return;
    }

    const zip = entries.find((entry) => /\.zip$/i.test(entry.path));
    if (zip) {
        await loadProject(await projectFromZip(zip.blob));
        return;
    }

    await loadProject(await projectFromEntries(entries, entries[0].path));
}

function initDragAndDrop() {
    let depth = 0;
    const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) {
            return;
        }
        event.preventDefault();
        depth++;
        els.dropOverlay.classList.add('visible');
    });
    window.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) {
            return;
        }
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
            els.dropOverlay.classList.remove('visible');
        }
    });
    window.addEventListener('drop', async (event) => {
        if (!hasFiles(event)) {
            return;
        }
        event.preventDefault();
        depth = 0;
        els.dropOverlay.classList.remove('visible');
        try {
            await handleDrop(event.dataTransfer);
        } catch (error) {
            console.error(error);
            log(`Could not load the dropped project: ${error.message}`, 'error');
            setStatus(`Could not load the dropped project: ${error.message}`);
        }
    });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const defaults = { ticksPerSecond: 30, zoom: 'fit', theme: 'dark' };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch (error) {
        return defaults;
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            ticksPerSecond: app.ticksPerSecond,
            zoom: app.zoom,
            theme: document.documentElement.dataset.theme,
        }));
    } catch (error) {
        /* ignore unavailable storage */
    }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function bindActions() {
    const actions = {
        'open-folder': openFolder,
        'open-zip': openZip,
        'open-json': openProgram,
        example: loadExample,
    };

    for (const element of document.querySelectorAll('[data-action]')) {
        element.addEventListener('click', (event) => {
            event.preventDefault();
            const action = actions[element.dataset.action];
            if (action) {
                Promise.resolve(action()).catch((error) => {
                    console.error(error);
                    log(error.message, 'error');
                    setStatus(error.message);
                });
            }
        });
    }

    $('openFolderBtn').addEventListener('click', () => openFolder().catch(showError));
    $('openZipBtn').addEventListener('click', () => openZip().catch(showError));
    $('openJsonBtn').addEventListener('click', () => openProgram().catch(showError));
    $('exampleBtn').addEventListener('click', () => loadExample().catch(showError));

    els.playBtn.addEventListener('click', () => setPlaying(!app.playing));
    els.stepBtn.addEventListener('click', stepOnce);
    els.restartBtn.addEventListener('click', () => restart().catch(showError));

    els.speedInput.addEventListener('input', () => {
        app.ticksPerSecond = Number(els.speedInput.value) || 30;
        els.speedValue.textContent = `${app.ticksPerSecond}/s`;
        saveSettings();
    });

    els.zoomInput.addEventListener('change', () => {
        app.zoom = els.zoomInput.value;
        applyZoom();
        saveSettings();
    });

    els.themeBtn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        saveSettings();
    });

    window.addEventListener('resize', () => {
        if (app.zoom === 'fit') {
            applyZoom();
        }
    });

    document.addEventListener('keydown', (event) => {
        const tag = event.target && event.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            return;
        }
        if (!els.dialogBackdrop.hidden) {
            return;
        }
        if (event.code === 'Space') {
            event.preventDefault();
            setPlaying(!app.playing);
        } else if (event.code === 'ArrowRight') {
            event.preventDefault();
            stepOnce();
        } else if (event.key === 'r' || event.key === 'R') {
            event.preventDefault();
            restart().catch(showError);
        }
    });
}

function showError(error) {
    console.error(error);
    log(error.message, 'error');
    setStatus(error.message);
}

function init() {
    // settings
    app.ticksPerSecond = Number(app.settings.ticksPerSecond) || 30;
    app.zoom = String(app.settings.zoom || 'fit');
    els.speedInput.value = String(app.ticksPerSecond);
    els.speedValue.textContent = `${app.ticksPerSecond}/s`;
    els.zoomInput.value = app.zoom;
    setTheme(app.settings.theme === 'light' ? 'light' : 'dark');

    bindActions();
    initDragAndDrop();
    enableControls(false);
    updateInspector();
    log('Ready. Drop a .zip, a folder or a program .json to play it.', 'good');

    const params = new URLSearchParams(window.location.search);
    const example = params.get('example');
    if (example) {
        loadExample().catch(showError);
    }
}

init();

// Exposed for the browser smoke test (and for tinkering in the console).
window.tzoAnimApp = {
    player,
    renderer,
    app,
    loadProject,
    loadExample,
    openZipBlob: (blob) => projectFromZip(blob).then((project) => loadProject(project)),
    loadEntries: (entries) => projectFromEntries(entries).then((project) => loadProject(project)),
    setPlaying,
    stepOnce,
};
