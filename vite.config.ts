import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Camera access works on http://localhost without HTTPS. If you open the game
// from another device on the network, browsers require HTTPS: see README.
export default defineConfig({
    base: './',
    plugins: [react()],
    server: { port: 5173, host: true },
    preview: { port: 4173, host: true },
    build: { chunkSizeWarningLimit: 2000 },
});
