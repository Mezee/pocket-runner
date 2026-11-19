// Endless scenery: tiles that recycle around the player. Placement is a pure
// function of the tile index, so the world is stable across frames.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { refs } from '../store';
import { LANE_WIDTH } from '../sim/sim';
import { toon, PALETTE } from './toon';

const TILE = 20;
const TILES_AHEAD = 9;
const TILES_BEHIND = 2;

function hash(i: number): number {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
}

function Tile({ index }: { index: number }) {
    const ties = useMemo(() => Array.from({ length: 8 }, (_, i) => -i * (TILE / 8)), []);
    const deco = useMemo(() => {
        const out: { x: number; z: number; h: number; w: number; d: number; c: string; kind: 'house' | 'tree' }[] = [];
        for (const side of [-1, 1]) {
            for (let k = 0; k < 2; k++) {
                const r = hash(index * 7 + side * 3 + k);
                const kind = r < 0.35 ? 'tree' : 'house';
                out.push({
                    x: side * (8.5 + hash(index * 13 + side + k) * 5),
                    z: -k * (TILE / 2) - hash(index + k * 5) * 4,
                    h: kind === 'tree' ? 2 + r * 2 : 4 + hash(index * 3 + side + k) * 8,
                    w: 3 + hash(index * 5 + side) * 2.5,
                    d: 4 + hash(index * 11 + k) * 3,
                    c: PALETTE.buildings[Math.floor(hash(index * 17 + side * 5 + k) * PALETTE.buildings.length)],
                    kind,
                });
            }
        }
        return out;
    }, [index]);

    return (
        <group position={[0, 0, -index * TILE]}>
            {/* grass */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, -TILE / 2]} material={toon(index % 2 ? PALETTE.grass : PALETTE.grassDark)}>
                <planeGeometry args={[80, TILE]} />
            </mesh>
            {/* track bed */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -TILE / 2]} material={toon(PALETTE.bed)}>
                <planeGeometry args={[LANE_WIDTH * 3 + 1.2, TILE]} />
            </mesh>
            {/* ties + rails per lane */}
            {[-1, 0, 1].map((lane) => (
                <group key={lane} position={[lane * LANE_WIDTH, 0, 0]}>
                    {ties.map((z) => (
                        <mesh key={z} position={[0, 0.05, z]} material={toon(PALETTE.tie)}>
                            <boxGeometry args={[2.2, 0.1, 0.45]} />
                        </mesh>
                    ))}
                    {[-0.7, 0.7].map((x) => (
                        <mesh key={x} position={[x, 0.16, -TILE / 2]} material={toon(PALETTE.rail)}>
                            <boxGeometry args={[0.12, 0.12, TILE]} />
                        </mesh>
                    ))}
                </group>
            ))}
            {/* side walls */}
            {[-1, 1].map((s) => (
                <mesh key={s} position={[s * (LANE_WIDTH * 1.5 + 0.9), 0.4, -TILE / 2]} material={toon('#ced4da')}>
                    <boxGeometry args={[0.4, 0.8, TILE]} />
                </mesh>
            ))}
            {/* houses + trees */}
            {deco.map((d, i) =>
                d.kind === 'house' ? (
                    <group key={i} position={[d.x, 0, d.z]}>
                        <mesh position={[0, d.h / 2, 0]} material={toon(d.c)}>
                            <boxGeometry args={[d.w, d.h, d.d]} />
                        </mesh>
                        <mesh position={[0, d.h + 0.9, 0]} rotation={[0, Math.PI / 4, 0]} material={toon('#fa5252')}>
                            <coneGeometry args={[Math.max(d.w, d.d) * 0.75, 1.8, 4]} />
                        </mesh>
                        {[0.3, 0.65].map((fy) => (
                            <mesh key={fy} position={[-Math.sign(d.x) * (d.w / 2 + 0.01), d.h * fy, 0]} rotation={[0, (Math.sign(d.x) * -Math.PI) / 2, 0]} material={toon('#e7f5ff', '#a5d8ff')}>
                                <planeGeometry args={[d.d * 0.6, d.h * 0.18]} />
                            </mesh>
                        ))}
                    </group>
                ) : (
                    <group key={i} position={[d.x, 0, d.z]}>
                        <mesh position={[0, d.h * 0.35, 0]} material={toon('#8d5b3a')}>
                            <cylinderGeometry args={[0.25, 0.32, d.h * 0.7, 8]} />
                        </mesh>
                        <mesh position={[0, d.h * 0.85, 0]} material={toon('#2f9e44')}>
                            <icosahedronGeometry args={[d.h * 0.45, 0]} />
                        </mesh>
                    </group>
                ),
            )}
        </group>
    );
}

export function World() {
    const group = useRef<THREE.Group>(null);
    const first = useRef(0);
    const [tiles, setTiles] = useTilesState();

    useFrame(() => {
        const f = Math.floor(refs.dist / TILE) - TILES_BEHIND;
        if (f !== first.current) {
            first.current = f;
            setTiles(f);
        }
    });

    return (
        <group ref={group}>
            {tiles.map((i) => (
                <Tile key={i} index={i} />
            ))}
        </group>
    );
}

import { useState, useCallback } from 'react';
function useTilesState(): [number[], (first: number) => void] {
    const make = (f: number) => Array.from({ length: TILES_AHEAD + TILES_BEHIND }, (_, k) => f + k);
    const [tiles, set] = useState(() => make(-TILES_BEHIND));
    const update = useCallback((f: number) => set(make(f)), []);
    return [tiles, update];
}
