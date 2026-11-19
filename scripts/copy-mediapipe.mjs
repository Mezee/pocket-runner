// Copies the MediaPipe WASM runtime out of node_modules into public/ so the game
// runs fully offline from localhost (no CDN at play time).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dst = join(root, 'public/mediapipe/wasm');
if (!existsSync(src)) {
    console.warn('[copy-mediapipe] tasks-vision not installed yet; skipping');
    process.exit(0);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('[copy-mediapipe] copied wasm runtime ->', dst);
