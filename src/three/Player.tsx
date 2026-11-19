// Original primitive-geometry runner character (no external assets).
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { refs } from '../store';
import { toon, PALETTE } from './toon';

const JUMP_HEIGHT = 2.4;

function Limb({ len, r, color, shoe }: { len: number; r: number; color: string; shoe?: boolean }) {
    return (
        <group>
            <mesh position={[0, -len / 2, 0]} material={toon(color)}>
                <capsuleGeometry args={[r, len - r * 2, 4, 10]} />
            </mesh>
            {shoe && (
                <mesh position={[0, -len, -0.08]} material={toon(PALETTE.shoe)}>
                    <boxGeometry args={[0.26, 0.14, 0.42]} />
                </mesh>
            )}
        </group>
    );
}

export function Player() {
    const root = useRef<THREE.Group>(null);
    const body = useRef<THREE.Group>(null);
    const lArm = useRef<THREE.Group>(null);
    const rArm = useRef<THREE.Group>(null);
    const lLeg = useRef<THREE.Group>(null);
    const rLeg = useRef<THREE.Group>(null);
    const shadow = useRef<THREE.Mesh>(null);
    const slideT = useRef(0);

    useFrame((state, delta) => {
        const dt = Math.min(delta, 0.05);
        const g = root.current;
        if (!g || !body.current) return;
        g.position.x = refs.x;
        const y = refs.jump * JUMP_HEIGHT;
        slideT.current = THREE.MathUtils.lerp(slideT.current, refs.sliding ? 1 : 0, dt * 18);
        const sl = slideT.current;

        // Running cycle speed follows game speed (idle bounce when stopped).
        refs.runPhase += dt * (refs.speed > 0.5 ? 4 + refs.speed * 0.45 : 2);
        const p = refs.runPhase;
        const amp = refs.speed > 0.5 ? 0.9 : 0.15;
        const air = refs.jump > 0.01;
        const swing = air ? 0 : Math.sin(p) * amp;

        body.current.position.y = y + (air ? 0 : Math.abs(Math.sin(p)) * 0.08 * amp) - sl * 0.55;
        body.current.rotation.x = air ? -0.2 : sl * -1.1 + (refs.speed > 0.5 ? -0.12 : 0);
        body.current.rotation.z = THREE.MathUtils.lerp(body.current.rotation.z, -refs.lean * 0.25, dt * 10);
        if (lLeg.current && rLeg.current && lArm.current && rArm.current) {
            lLeg.current.rotation.x = air ? -0.9 : sl ? -1.2 : swing;
            rLeg.current.rotation.x = air ? 0.4 : sl ? -1.3 : -swing;
            lArm.current.rotation.x = air ? -2.6 : -swing * 1.1;
            rArm.current.rotation.x = air ? -2.6 : swing * 1.1;
            lArm.current.rotation.z = air ? -0.3 : 0.12;
            rArm.current.rotation.z = air ? 0.3 : -0.12;
        }
        g.visible = !refs.invuln || Math.floor(state.clock.elapsedTime * 14) % 2 === 0;
        if (shadow.current) {
            const s = 1 - refs.jump * 0.45;
            shadow.current.scale.set(s, s, s);
        }
    });

    return (
        <group ref={root}>
            <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
                <circleGeometry args={[0.6, 24]} />
                <meshBasicMaterial color="#000" transparent opacity={0.28} depthWrite={false} />
            </mesh>
            <group ref={body}>
                {/* legs (hip pivot at y=1.0) */}
                <group ref={lLeg} position={[-0.2, 1.0, 0]}>
                    <Limb len={1.0} r={0.15} color={PALETTE.pants} shoe />
                </group>
                <group ref={rLeg} position={[0.2, 1.0, 0]}>
                    <Limb len={1.0} r={0.15} color={PALETTE.pants} shoe />
                </group>
                {/* torso */}
                <RoundedBox args={[0.8, 0.85, 0.5]} radius={0.16} position={[0, 1.45, 0]} material={toon(PALETTE.hoodie)} />
                {/* backpack (we see the runner from behind) */}
                <RoundedBox args={[0.55, 0.6, 0.25]} radius={0.1} position={[0, 1.5, 0.35]} material={toon('#4dabf7')} />
                {/* arms (shoulder pivot) */}
                <group ref={lArm} position={[-0.52, 1.78, 0]}>
                    <Limb len={0.8} r={0.12} color={PALETTE.hoodie} />
                </group>
                <group ref={rArm} position={[0.52, 1.78, 0]}>
                    <Limb len={0.8} r={0.12} color={PALETTE.hoodie} />
                </group>
                {/* head + cap */}
                <mesh position={[0, 2.2, 0]} material={toon(PALETTE.skin)}>
                    <sphereGeometry args={[0.34, 20, 16]} />
                </mesh>
                <mesh position={[0, 2.38, 0]} material={toon(PALETTE.cap)}>
                    <sphereGeometry args={[0.35, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
                </mesh>
                <mesh position={[0, 2.38, -0.32]} rotation={[0.15, 0, 0]} material={toon(PALETTE.cap)}>
                    <boxGeometry args={[0.5, 0.05, 0.32]} />
                </mesh>
            </group>
        </group>
    );
}
