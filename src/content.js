/*
 * Loading TZO animation projects from the browser.
 *
 * A "project" is a set of files (program .json + content images) coming from
 *   - a .zip archive,
 *   - a folder (File System Access API or a webkitdirectory input),
 *   - loose files / a drag & drop,
 *   - the bundled example (fetched over HTTP).
 *
 * Image lookups try the exact path first and then the file name, so archives
 * that keep a directory prefix around still work.
 */

import { unzipSync } from 'fflate';

export function normalizePath(path) {
    return String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function basename(path) {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf('/');
    return index === -1 ? normalized : normalized.substring(index + 1);
}

function guessContentType(path) {
    const extension = path.toLowerCase().split('.').pop();
    switch (extension) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'json':
            return 'application/json';
        default:
            return 'application/octet-stream';
    }
}

export class ContentStore {
    /**
     * @param {Array<{path: string, blob: Blob}>} entries
     * @param {{baseUrl?: URL|null}} [options] when set, unknown paths are fetched relative to it
     */
    constructor(entries = [], { baseUrl = null } = {}) {
        this.byPath = new Map();
        this.byName = new Map();
        this.baseUrl = baseUrl;
        for (const entry of entries) {
            this.add(entry);
        }
    }

    add({ path, blob }) {
        const normalized = normalizePath(path);
        this.byPath.set(normalized.toLowerCase(), { path: normalized, blob });
        const name = basename(normalized).toLowerCase();
        if (!this.byName.has(name)) {
            this.byName.set(name, { path: normalized, blob });
        }
    }

    lookup(path) {
        const normalized = normalizePath(path).toLowerCase();
        const exact = this.byPath.get(normalized);
        if (exact) {
            return exact;
        }
        return this.byName.get(basename(normalized)) || null;
    }

    /**
     * Resolve a path used by the program to a Blob.
     * @returns {Promise<Blob|null>}
     */
    async resolve(path) {
        const entry = this.lookup(path);
        if (entry) {
            return entry.blob;
        }
        if (this.baseUrl) {
            const url = new URL(normalizePath(path), this.baseUrl);
            // Retry once: a freshly deployed page can hit a CDN hiccup while
            // dozens of images are fetched in parallel.
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const response = await fetch(url);
                    if (response.ok) {
                        const blob = await response.blob();
                        this.add({ path, blob });
                        return blob;
                    }
                    if (response.status < 500) {
                        break;
                    }
                } catch (error) {
                    /* network error: retry */
                }
            }
        }
        return null;
    }

    get size() {
        return this.byPath.size;
    }
}

/**
 * When every file lives inside one top-level folder, strip it so program paths
 * like "base/comm/x.png" still match.
 */
function stripCommonRoot(entries) {
    if (entries.length === 0) {
        return entries;
    }
    const roots = new Set(entries.map((entry) => normalizePath(entry.path).split('/')[0]));
    const nested = entries.every((entry) => normalizePath(entry.path).includes('/'));
    if (!nested || roots.size !== 1) {
        return entries;
    }
    const root = [...roots][0];
    return entries.map((entry) => {
        const path = normalizePath(entry.path);
        return { ...entry, path: path.substring(root.length + 1) };
    });
}

/**
 * Turn a list of files into a project: a content store plus every JSON file
 * that looks like a TZO program.
 *
 * @param {Array<{path: string, blob: Blob}>} entries
 * @param {string} [label]
 */
export async function buildProject(entries, label = '') {
    const normalized = stripCommonRoot(entries.map((entry) => ({
        path: normalizePath(entry.path),
        blob: entry.blob,
    })));

    const store = new ContentStore(normalized);
    const programs = [];

    for (const entry of normalized) {
        if (!/\.json$/i.test(entry.path)) {
            continue;
        }
        try {
            const state = JSON.parse(await entry.blob.text());
            if (state && typeof state === 'object' && Array.isArray(state.programList)) {
                programs.push({
                    name: entry.path,
                    state,
                    instructions: state.programList.length,
                });
            }
        } catch (error) {
            /* not a JSON program — ignore */
        }
    }

    if (programs.length === 0) {
        throw new Error('No TZO program found: expected a .json file containing a "programList" array.');
    }

    // Prefer a program called program.json/animation.json if several are present.
    programs.sort((a, b) => {
        const rank = (program) => (/^(program|animation|anim)\.json$/i.test(basename(program.name)) ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

    return { label, store, programs };
}

/** Build a project from already-materialised entries (drag & drop). */
export function projectFromEntries(entries, label = '') {
    return buildProject(entries, label);
}

/** Build a project from a .zip file or Blob. */
export async function projectFromZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let entries;
    try {
        entries = unzipSync(bytes);
    } catch (error) {
        throw new Error(`Could not read ${file.name || 'the zip archive'}: ${error.message}`);
    }

    const files = [];
    for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith('/')) {
            continue;
        }
        files.push({ path, blob: new Blob([data], { type: guessContentType(path) }) });
    }
    if (files.length === 0) {
        throw new Error('The zip archive is empty.');
    }
    return buildProject(files, file.name || 'archive.zip');
}

/** Build a project from a FileList (file input, webkitdirectory input, drop). */
export function projectFromFiles(files, label = '') {
    const entries = Array.from(files).map((file) => ({
        path: file.webkitRelativePath || file.name,
        blob: file,
    }));
    const inferredLabel = label || (entries[0]?.path.includes('/') ? entries[0].path.split('/')[0] : '');
    return buildProject(entries, inferredLabel);
}

/** Recursively read every file in a FileSystemDirectoryHandle. */
export async function entriesFromDirectoryHandle(dirHandle, prefix = '', depth = 0, out = []) {
    if (depth > 8) {
        return out;
    }
    for await (const [name, handle] of dirHandle.entries()) {
        if (name.startsWith('.')) {
            continue;
        }
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            await entriesFromDirectoryHandle(handle, path, depth + 1, out);
        } else {
            out.push({ path, blob: await handle.getFile() });
        }
    }
    return out;
}

/** Build a project from a folder picked with the File System Access API. */
export async function projectFromDirectoryHandle(dirHandle) {
    const entries = await entriesFromDirectoryHandle(dirHandle);
    return buildProject(entries, dirHandle.name);
}
