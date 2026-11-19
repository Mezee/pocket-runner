// Obstacle + coin visuals (original primitive geometry). Bull Rush's
// Obstacles.tsx (MIT) was the structural reference: one component per kind.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { CellKind } from '../sim/sim';
import { toon, stripeTexture, PALETTE } from './toon';

let hurdleTex: THREE.CanvasTexture | null = null;
let barTex: THREE.CanvasTexture | null = null;

/** Lane-blocking "train car" — must change lane. */
function Block({ variant }: { variant: number }) {
    const color = [PALETTE.trainA, PALETTE.trainB, PALETTE.trainC][variant % 3];
    // Near face (facing the player, +z) sits exactly on the collision line.
    return (
        <group position={[0, 0, -3.5]}>
            <RoundedBox args={[2.5, 3.0, 7]} radius={0.3} position={[0, 1.75, 0]} material={toon(color)} />
            {/* roof */}
            <RoundedBox args={[2.3, 0.3, 6.6]} radius={0.12} position={[0, 3.35, 0]} material={toon('#dee2e6')} />
            {/* front window + stripe */}
            <mesh position={[0, 2.3, 3.52]} material={toon('#a5d8ff', '#a5d8ff')}>
                <boxGeometry args={[1.8, 0.9, 0.05]} />
            </mesh>
            <mesh position={[0, 1.2, 3.52]} material={toon('#ffffff')}>
                <boxGeometry args={[2.3, 0.25, 0.05]} />
            </mesh>
            {/* headlights */}
            {[-0.75, 0.75].map((x) => (
                <mesh key={x} position={[x, 0.75, 3.53]} material={toon('#fff3bf', '#ffe066')}>
                    <circleGeometry args={[0.18, 16]} />
                </mesh>
            ))}
            {/* wheels */}
            {[-2.4, 2.4].map((z) =>
                [-1.15, 1.15].map((x) => (
                    <mesh key={`${x}${z}`} position={[x, 0.32, z]} rotation={[0, 0, Math.PI / 2]} material={toon('#343a40')}>
                        <cylinderGeometry args={[0.32, 0.32, 0.2, 14]} />
                    </mesh>
                )),
            )}
        </group>
    );
}

/** Low hurdle — jump over it. */
function Low() {
    const tex = useMemo(() => (hurdleTex ??= stripeTexture(PALETTE.hurdle, PALETTE.hurdleRed)), []);
    return (
        <group>
            {[-1.1, 1.1].map((x) => (
                <mesh key={x} position={[x, 0.45, 0]} material={toon('#495057')}>
                    <boxGeometry args={[0.16, 0.9, 0.16]} />
                </mesh>
            ))}
            <mesh position={[0, 0.75, 0]}>
                <boxGeometry args={[2.6, 0.42, 0.18]} />
                <meshToonMaterial map={tex} />
            </mesh>
        </group>
    );
}

/** Overhead bar — duck under it. */
function High() {
    const tex = useMemo(() => (barTex ??= stripeTexture(PALETTE.bar, '#212529', 8)), []);
    return (
        <group>
            {[-1.35, 1.35].map((x) => (
                <mesh key={x} position={[x, 1.1, 0]} material={toon('#495057')}>
                    <boxGeometry args={[0.18, 2.2, 0.18]} />
                </mesh>
            ))}
            <mesh position={[0, 1.75, 0]}>
                <boxGeometry args={[2.9, 0.9, 0.25]} />
                <meshToonMaterial map={tex} />
            </mesh>
        </group>
    );
}

function Coin() {
    const ref = useRef<THREE.Group>(null);
    useFrame((s) => {
        if (ref.current) ref.current.rotation.y = s.clock.elapsedTime * 3;
    });
    return (
        <group ref={ref} position={[0, 1.1, 0]}>
            <mesh rotation={[Math.PI / 2, 0, 0]} material={toon(PALETTE.coin, '#ffd43b')}>
                <cylinderGeometry args={[0.42, 0.42, 0.1, 22]} />
            </mesh>
        </group>
    );
}

export function Obstacle({ kind, variant }: { kind: CellKind; variant: number }) {
    switch (kind) {
        case 'block':
            return <Block variant={variant} />;
        case 'low':
            return <Low />;
        case 'high':
            return <High />;
        case 'coin':
            return <Coin />;
    }
}
