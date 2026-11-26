/**
 * Tells a short press from a hold, for keys and dials.
 *
 * Stream Deck only reports "down" and "up", so we start a timer on down. If it
 * fires before up, it's a hold, and we act straight away (while the finger is
 * still down, so the feedback is immediate). If up comes first, it's a press.
 */
export const HOLD_MS = 500;

export type PressResult = "press" | "hold" | "none";

export class PressTracker {
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly held = new Set<string>();

	down(id: string, onHold: () => void): void {
		this.cancel(id);
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id);
				this.held.add(id);
				onHold();
			}, HOLD_MS),
		);
	}

	/** "press" for a short press, "hold" if the hold already fired, "none" if we never saw the down. */
	up(id: string): PressResult {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
			return "press";
		}
		return this.held.delete(id) ? "hold" : "none";
	}

	cancel(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
		this.held.delete(id);
	}
}
