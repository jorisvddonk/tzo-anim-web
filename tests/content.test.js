import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
    ContentStore,
    buildProject,
    entriesFromDirectoryHandle,
    projectFromDirectoryHandle,
    projectFromEntries,
    projectFromFiles,
    projectFromZip,
} from '../src/content.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

const blob = (text) => new Blob([text], { type: 'text/plain' });

test('ContentStore resolves exact paths, file names and is case insensitive', () => {
    const store = new ContentStore([
        { path: 'base/comm/chmmr/chmmr.0.png', blob: blob('zero') },
        { path: 'base/comm/chmmr/chmmr.1.png', blob: blob('one') },
    ]);

    assert.equal(store.lookup('base/comm/chmmr/chmmr.0.png').path, 'base/comm/chmmr/chmmr.0.png');
    assert.equal(store.lookup('CHMMR.1.PNG').path, 'base/comm/chmmr/chmmr.1.png');
    assert.equal(store.lookup('base\\comm\\chmmr\\chmmr.0.png').path, 'base/comm/chmmr/chmmr.0.png');
    assert.equal(store.lookup('missing.png'), null);
    assert.equal(store.size, 2);
});

test('ContentStore can fall back to fetching from a base URL', async () => {
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).endsWith('frame0.png')) {
            return { ok: true, blob: async () => blob('fetched') };
        }
        return { ok: false };
    };

    try {
        const store = new ContentStore([], { baseUrl: new URL('https://example.test/examples/demo/') });
        assert.equal(await store.resolve('frame0.png'), await store.resolve('frame0.png'));
        assert.equal(requested.length, 1, 'the fetched image is cached');
        assert.equal(await store.resolve('nope.png'), null);
        assert.equal(requested.length, 3, 'a 404 is tried twice (one retry)');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('buildProject strips a single top-level folder and finds the program', async () => {
    const project = await projectFromEntries([
        { path: 'sample/program.json', blob: blob(JSON.stringify({ programList: [{ type: 'push-number-instruction', value: 1 }] })) },
        { path: 'sample/frame0.png', blob: blob('png') },
    ], 'sample');

    assert.equal(project.programs.length, 1);
    assert.equal(project.programs[0].name, 'program.json');
    assert.equal(project.programs[0].instructions, 1);
    assert.ok(project.store.lookup('frame0.png'));
});

test('buildProject ignores JSON files that are not TZO programs', async () => {
    const project = await projectFromEntries([
        { path: 'meta.json', blob: blob(JSON.stringify({ hello: 'world' })) },
        { path: 'broken.json', blob: blob('{ not json') },
        { path: 'program.json', blob: blob(JSON.stringify({ programList: [] })) },
    ]);
    assert.deepEqual(project.programs.map((program) => program.name), ['program.json']);
});

test('buildProject throws when there is no program', async () => {
    await assert.rejects(
        () => projectFromEntries([{ path: 'frame0.png', blob: blob('png') }]),
        /No TZO program found/,
    );
});

test('projectFromZip reads the fixture archive', async () => {
    const zip = new File([readFileSync(join(fixtures, 'sample.zip'))], 'sample.zip', { type: 'application/zip' });
    const project = await projectFromZip(zip);

    assert.equal(project.label, 'sample.zip');
    assert.equal(project.programs.length, 1);
    assert.equal(project.programs[0].name, 'program.json');
    assert.equal(project.programs[0].state.labelMap.mainAnimationLoop > 0, true);
    assert.equal(project.store.size, 3);
    assert.ok(await project.store.resolve('frame0.png'));
    assert.ok(await project.store.resolve('frame1.png'));
});

test('projectFromFiles understands webkitRelativePath folders', async () => {
    const programText = JSON.stringify({ programList: [] });
    const program = new File([programText], 'program.json', { type: 'application/json' });
    Object.defineProperty(program, 'webkitRelativePath', { value: 'demo/program.json' });
    const image = new File(['png'], 'frame0.png', { type: 'image/png' });
    Object.defineProperty(image, 'webkitRelativePath', { value: 'demo/frame0.png' });

    const project = await projectFromFiles([program, image], '');
    assert.equal(project.label, 'demo');
    assert.equal(project.programs[0].name, 'program.json');
    assert.ok(project.store.lookup('frame0.png'));
});

test('programs called program.json sort first', async () => {
    const program = (name) => ({ path: name, blob: blob(JSON.stringify({ programList: [] })) });
    const project = await buildProject([program('zzz.json'), program('program.json'), program('aaa.json')]);
    assert.deepEqual(project.programs.map((entry) => entry.name), ['program.json', 'aaa.json', 'zzz.json']);
});

test('entriesFromDirectoryHandle walks nested folders and builds a project', async () => {
    const fileHandle = (name, text) => ({
        kind: 'file',
        getFile: async () => new File([text], name),
    });
    const directoryHandle = (name, children) => ({
        kind: 'directory',
        name,
        async *entries() {
            for (const [childName, handle] of Object.entries(children)) {
                yield [childName, handle];
            }
        },
    });

    const handle = directoryHandle('demo', {
        'program.json': fileHandle('program.json', JSON.stringify({ programList: [{ type: 'invoke-function-instruction', functionName: 'pause' }] })),
        'base': directoryHandle('base', {
            'frame0.png': fileHandle('frame0.png', 'png'),
        }),
    });

    const entries = await entriesFromDirectoryHandle(handle);
    assert.deepEqual(entries.map((entry) => entry.path).sort(), ['base/frame0.png', 'program.json']);

    const project = await projectFromDirectoryHandle(handle);
    assert.equal(project.label, 'demo');
    assert.equal(project.programs[0].name, 'program.json');
    assert.ok(project.store.lookup('base/frame0.png'));
    assert.ok(await project.store.resolve('frame0.png'), 'resolved by file name too');
});

test('ContentStore retries a failing fetch once', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        if (calls === 1) {
            return { ok: false, status: 503 };
        }
        return { ok: true, blob: async () => blob('retried') };
    };

    try {
        const store = new ContentStore([], { baseUrl: new URL('https://example.test/x/') });
        const result = await store.resolve('a.png');
        assert.ok(result, 'the second attempt succeeds');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('ContentStore does not retry 404 responses', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return { ok: false, status: 404 };
    };

    try {
        const store = new ContentStore([], { baseUrl: new URL('https://example.test/x/') });
        assert.equal(await store.resolve('missing.png'), null);
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
