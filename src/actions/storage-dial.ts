import { type Action, action, type DialRotateEvent } from "@elgato/streamdeck";

import { COLOURS, formatBytesPair, formatPct, levelColour } from "../proxmox/format.js";
import { proxmox, type Snapshot, type Storage, webUiUrl } from "../proxmox/service.js";
import { LiveAction, wrapIndex } from "./live-action.js";
import { problemFeedback } from "./node-dial.js";

type Settings = { storage?: string }; // e.g. "storage/pve/local"

/**
 * Storage colours change later than CPU/RAM (80% / 90%): storage is meant to
 * fill up, but ZFS in particular is commonly advised to stay below ~80% to
 * keep performing well.
 */
export const storageColour = (pct: number | undefined) => levelColour(pct, 80, 90);

/**
 * Dial: your storage (local disk, LVM, ZFS pools, NAS shares) one at a time.
 * Turn: next / previous storage. Press: open it in the web UI. Hold, or tap
 * the strip: refresh. Uses data from the regular poll, so it costs nothing extra.
 */
@action({ UUID: "com.jere.proxmox-deck.storage-dial" })
export class StorageDial extends LiveAction<Settings> {
	private selected(settings: Settings, snapshot: Snapshot | undefined): { storage?: Storage; index: number; total: number } {
		const list = snapshot?.ok ? snapshot.storages : [];
		const found = list.findIndex((s) => s.key === settings.storage);
		const index = found >= 0 ? found : 0;
		return { storage: list[index], index, total: list.length };
	}

	protected override link(settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		const { storage } = this.selected(settings, snapshot);
		return snapshot?.ok && storage ? webUiUrl(snapshot.baseUrl, { type: "storage", id: `${storage.node}/${storage.name}` }) : undefined;
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isDial()) return;
		const problem = problemFeedback(snapshot);
		if (problem) return action.setFeedback(problem);

		const { storage: s, index, total } = this.selected(settings, snapshot);
		if (!s) {
			return action.setFeedback({ name: "Storage", pos: "", value: { value: "None", color: COLOURS.muted }, bar: { enabled: false }, detail: { value: "No storage visible to the token", color: COLOURS.muted } });
		}

		const available = s.status === "available";
		const colour = storageColour(s.usedPct);
		await action.setFeedback({
			name: `${s.name}${s.shared ? " · shared" : ""}`,
			pos: `${index + 1}/${total}`,
			value: available ? { value: formatPct(s.usedPct), color: colour } : { value: "Offline", color: COLOURS.bad },
			bar: available && s.usedPct !== undefined ? { enabled: true, value: Math.round(s.usedPct), bar_fill_c: colour } : { enabled: false },
			detail: { value: available ? `${formatBytesPair(s.used, s.total)} · ${s.type}` : `${s.type} · ${s.status}`, color: COLOURS.muted },
		});
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const snapshot = proxmox.snapshot;
		const list = snapshot?.ok ? snapshot.storages : [];
		if (list.length === 0) return;
		const settings = this.settingsOf(ev.action.id);
		const { index } = this.selected(settings, snapshot);
		const next = list[wrapIndex(index + ev.payload.ticks, list.length)]!;
		await this.saveSettings(ev.action, { ...settings, storage: next.key });
		await this.draw(ev.action);
	}
}
