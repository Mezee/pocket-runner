// Cartoony toon materials (procedural; no texture assets).
import * as THREE from 'three';

let gradient: THREE.DataTexture | null = null;
function gradientMap(): THREE.DataTexture {
    if (gradient) return gradient;
    const steps = new Uint8Array([90, 170, 255]);
    gradient = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
    return gradient;
}

const cache = new Map<string, THREE.MeshToonMaterial>();
export function toon(color: string, emissive?: string): THREE.MeshToonMaterial {
    const key = color + (emissive ?? '');
    let m = cache.get(key);
    if (!m) {
        m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
        if (emissive) {
            m.emissive = new THREE.Color(emissive);
            m.emissiveIntensity = 0.35;
        }
        cache.set(key, m);
    }
    return m;
}

/** Striped canvas texture (hurdles, bars). */
export function stripeTexture(a: string, b: string, stripes = 6): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 16;
    const g = c.getContext('2d')!;
    const w = c.width / stripes;
    for (let i = 0; i < stripes; i++) {
        g.fillStyle = i % 2 ? b : a;
        g.beginPath();
        g.moveTo(i * w, 0);
        g.lineTo(i * w + w, 0);
        g.lineTo(i * w + w - 8, 16);
        g.lineTo(i * w - 8, 16);
        g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/** Vertical sky gradient as a scene background. */
export function skyTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#3fa9ff');
    grd.addColorStop(0.55, '#8fd3ff');
    grd.addColorStop(1, '#ffe6b0');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

export const PALETTE = {
    grass: '#5ccf4f',
    grassDark: '#3fae3a',
    bed: '#b98a63',
    tie: '#7a4a2c',
    rail: '#d8dde6',
    buildings: ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#63e6be'],
    trainA: '#e03131',
    trainB: '#1c7ed6',
    trainC: '#f59f00',
    hurdle: '#ffffff',
    hurdleRed: '#fa5252',
    bar: '#ffd43b',
    coin: '#ffd43b',
    skin: '#f1c27d',
    hoodie: '#ff922b',
    pants: '#364fc7',
    shoe: '#ffffff',
    cap: '#e03131',
};
