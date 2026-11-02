import { defineConfig } from 'vite';

export default defineConfig({
    // Relative base so the build works from any GitHub Pages path.
    base: './',
    build: {
        outDir: 'dist',
        target: 'es2022',
        sourcemap: true,
    },
    server: {
        port: 5173,
    },
});
