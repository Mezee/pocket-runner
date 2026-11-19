// Keyboard producer: ←/→ (or A/D) lanes, Space/↑/W jump, ↓/S duck.
import { controlBus } from './bus';

export function attachKeyboard(): () => void {
    const onKey = (e: KeyboardEvent) => {
        if (e.repeat) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
        const k = e.key.toLowerCase();
        const now = performance.now();
        let handled = true;
        if (k === 'arrowleft' || k === 'a') controlBus.emit('left', 'keyboard', { onsetAt: now });
        else if (k === 'arrowright' || k === 'd') controlBus.emit('right', 'keyboard', { onsetAt: now });
        else if (k === ' ' || k === 'arrowup' || k === 'w') controlBus.emit('jump', 'keyboard', { onsetAt: now });
        else if (k === 'arrowdown' || k === 's') controlBus.emit('duck', 'keyboard', { onsetAt: now });
        else handled = false;
        if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
}
