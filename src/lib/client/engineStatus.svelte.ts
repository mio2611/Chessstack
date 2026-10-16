// Reactive mirror of the client engine's health (see stockfish.ts), so the
// UI can react to a failed engine (message, retry control, automatic
// recovery once another surface has restarted it). Written only by
// stockfish.ts; everything else treats it as read-only.
import type { EngineUnavailableReason } from './stockfish';

export const engineStatus = $state<{
	state: 'idle' | 'loading' | 'ready' | 'failed';
	reason: EngineUnavailableReason | null;
}>({ state: 'idle', reason: null });
