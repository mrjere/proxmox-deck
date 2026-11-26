import { type Action, action, type DialRotateEvent } from "@elgato/streamdeck";

import { COLOURS, formatPct, formatUptime, levelColour, statusColour } from "../proxmox/format.js";
import { type Guest, proxmox, type Snapshot, webUiUrl } from "../proxmox/service.js";
import { guestLabel } from "./guest-key.js";
import { LiveAction, wrapIndex } from "./live-action.js";
import { problemFeedback } from "./node-dial.js";

type Settings = { guest?: string; filter?: "all" | "running" };

function visibleGuests(snapshot: Snapshot | undefined, filter: Settings["filter"]): Guest[] {
	if (!snapshot?.ok) return [];
	return filter === "running" ? snapshot.guests.filter((g) => g.status === "running") : snapshot.guests;
}

/**
 * Dial: a carousel of your containers and VMs.
 * Turn: step through them (your place is remembered). Press: open the selected
 * one in the web UI. Hold, or tap the strip: refresh.
 */
@action({ UUID: "com.jere.proxmox-deck.guest-dial" })
export class GuestDial extends LiveAction<Settings> {
	protected override readonly statusItem = "sub";

	private selected(settings: Settings, snapshot: Snapshot | undefined): { guest?: Guest; index: number; total: number } {
		const list = visibleGuests(snapshot, settings.filter);
		const found = list.findIndex((g) => g.key === settings.guest);
		const index = found >= 0 ? found : 0;
		return { guest: list[index], index, total: list.length };
	}

	protected override link(settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		const { guest } = this.selected(settings, snapshot);
		return snapshot?.ok && guest ? webUiUrl(snapshot.baseUrl, { type: guest.type, id: guest.vmid }) : undefined;
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isDial()) return;
		const empty = { cpu: { value: 0 }, cpu_val: "", mem: { value: 0 }, mem_val: "" };
		const problem = problemFeedback(snapshot);
		if (problem) return action.setFeedback({ ...empty, name: problem.name!, pos: "", sub: problem.detail! });

		const { guest, index, total } = this.selected(settings, snapshot);
		if (!guest) {
			return action.setFeedback({
				...empty,
				name: "No guests",
				pos: "",
				sub: { value: settings.filter === "running" ? "Nothing running" : "None on this host", color: COLOURS.muted },
			});
		}

		const running = guest.status === "running";
		await action.setFeedback({
			name: guest.name,
			pos: `${index + 1}/${total}`,
			sub: { value: `${guestLabel(guest)} · ${guest.status}${running ? ` · ${formatUptime(guest.uptime)}` : ""}`, color: statusColour(guest.status) },
			cpu: { value: running ? Math.round(guest.cpuPct ?? 0) : 0, bar_fill_c: levelColour(guest.cpuPct) },
			cpu_val: running ? formatPct(guest.cpuPct) : "–",
			mem: { value: running ? Math.round(guest.memPct ?? 0) : 0, bar_fill_c: levelColour(guest.memPct) },
			mem_val: running ? formatPct(guest.memPct) : "–",
		});
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const settings = this.settingsOf(ev.action.id);
		const list = visibleGuests(proxmox.snapshot, settings.filter);
		if (list.length === 0) return;
		const { index } = this.selected(settings, proxmox.snapshot);
		const next = list[wrapIndex(index + ev.payload.ticks, list.length)]!;
		await this.saveSettings(ev.action, { ...settings, guest: next.key });
		await this.draw(ev.action);
	}
}
