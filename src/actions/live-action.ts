import streamDeck, {
	type Action,
	type DialDownEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type KeyUpEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { COLOURS, truncate } from "../proxmox/format.js";
import { type Feature, proxmox, type Snapshot } from "../proxmox/service.js";
import { PressTracker } from "./press.js";

/**
 * Base class for every action in the plugin.
 *
 * - Subscribes to the shared Proxmox poller while at least one instance of the
 *   action is on screen, and unsubscribes when none are (so a hidden folder
 *   costs nothing).
 * - Keeps a copy of each instance's settings. In SDK v3, `onDidReceiveSettings`
 *   only fires for changes made in the settings page, so when the plugin itself
 *   changes settings (e.g. turning a dial) we update the copy ourselves.
 * - Gives every key and dial the same controls:
 *     press = open in the Proxmox web UI
 *     hold (½ s) = refresh now, with visible feedback
 *     tap / long-touch the strip = refresh now, with visible feedback
 */
export abstract class LiveAction<S extends JsonObject> extends SingletonAction<S> {
	private readonly visible = new Map<string, S>();
	private unsubscribe?: () => void;
	private readonly press = new PressTracker();
	private readonly flashes = new Map<string, { value: string; color: string; timer: NodeJS.Timeout }>();

	/** Extra data this action needs from the poller (fetched only while it's on screen). */
	protected readonly needs: readonly Feature[] = [];
	/** Touch-strip layout item used for status messages like "✓ Refreshed" (dials only). */
	protected readonly statusItem: string = "detail";

	/** Draw one instance of the action for the given snapshot (undefined = still connecting). */
	protected abstract render(action: Action<S>, settings: S, snapshot: Snapshot | undefined): Promise<void>;

	/** Where a press should take you in the web UI, or undefined if there's nowhere sensible. */
	protected abstract link(settings: S, snapshot: Snapshot | undefined): string | undefined;

	protected settingsOf(id: string): S {
		return this.visible.get(id) ?? ({} as S);
	}

	/** Save settings for an instance and keep our copy in sync. */
	protected async saveSettings(action: Action<S>, settings: S): Promise<void> {
		this.visible.set(action.id, settings);
		await action.setSettings(settings);
	}

	protected async draw(action: Action<S>): Promise<void> {
		try {
			await this.render(action, this.settingsOf(action.id), proxmox.snapshot);
			const flash = this.flashes.get(action.id);
			if (flash && action.isDial()) await action.setFeedback({ [this.statusItem]: { value: flash.value, color: flash.color } });
		} catch (err) {
			streamDeck.logger.error(`render failed for ${this.manifestId}`, err);
		}
	}

	private drawAll(): void {
		for (const action of this.actions) void this.draw(action);
	}

	/** Show a temporary status message on a dial's strip. */
	private flash(action: Action<S>, value: string, color: string, ms: number): void {
		const previous = this.flashes.get(action.id);
		if (previous) clearTimeout(previous.timer);
		const timer = setTimeout(() => {
			this.flashes.delete(action.id);
			void this.draw(action);
		}, ms);
		this.flashes.set(action.id, { value, color, timer });
	}

	/**
	 * Refresh now and SHOW that it happened. Keys get Stream Deck's tick (or
	 * warning triangle); dials get a message on the strip. Feedback matters:
	 * if a button seems to do nothing, people press it again, or stop trusting it.
	 */
	protected async refreshWithFeedback(action: Action<S>): Promise<void> {
		if (action.isDial()) {
			this.flash(action, "Refreshing…", COLOURS.muted, 15_000);
			await this.draw(action);
		}
		await proxmox.refresh({ force: true });
		const error = proxmox.lastError;

		if (action.isKey()) {
			await (error ? action.showAlert() : action.showOk());
			return;
		}
		if (!action.isDial()) return;
		if (error) {
			this.flash(action, `✗ ${truncate(error, 30)}`, COLOURS.bad, 4000);
			await action.showAlert();
		} else {
			this.flash(action, "✓ Refreshed", COLOURS.ok, 1500);
		}
		await this.draw(action);
	}

	private async open(action: Action<S>): Promise<void> {
		const url = this.link(this.settingsOf(action.id), proxmox.snapshot);
		if (url) {
			await streamDeck.system.openUrl(url);
		} else {
			if (action.isKey() || action.isDial()) await action.showAlert();
			void proxmox.refresh();
		}
	}

	// ---- Shared controls ----

	override onKeyDown(ev: KeyDownEvent<S>): void {
		this.press.down(ev.action.id, () => void this.refreshWithFeedback(ev.action));
	}

	override async onKeyUp(ev: KeyUpEvent<S>): Promise<void> {
		if (this.press.up(ev.action.id) === "press") await this.open(ev.action);
	}

	override onDialDown(ev: DialDownEvent<S>): void {
		this.press.down(ev.action.id, () => void this.refreshWithFeedback(ev.action));
	}

	override async onDialUp(ev: DialUpEvent<S>): Promise<void> {
		if (this.press.up(ev.action.id) === "press") await this.open(ev.action);
	}

	override async onTouchTap(ev: TouchTapEvent<S>): Promise<void> {
		await this.refreshWithFeedback(ev.action);
	}

	// ---- Lifecycle ----

	override async onWillAppear(ev: WillAppearEvent<S>): Promise<void> {
		this.visible.set(ev.action.id, ev.payload.settings);
		this.unsubscribe ??= proxmox.subscribe(() => this.drawAll(), this.needs);
		await this.draw(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<S>): void {
		this.visible.delete(ev.action.id);
		this.press.cancel(ev.action.id);
		const flash = this.flashes.get(ev.action.id);
		if (flash) clearTimeout(flash.timer);
		this.flashes.delete(ev.action.id);
		if (this.visible.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): Promise<void> {
		this.visible.set(ev.action.id, ev.payload.settings);
		await this.draw(ev.action);
	}
}

/** Wraps an index into 0..length-1, including for negative numbers (dial turned left). */
export function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}
