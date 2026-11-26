import { type Action, action } from "@elgato/streamdeck";

import { COLOURS } from "../proxmox/format.js";
import { type Guest, type Snapshot, webUiUrl } from "../proxmox/service.js";
import { guestKey, messageKey, toDataUrl } from "../render/key-images.js";
import { LiveAction } from "./live-action.js";
import { problemImage } from "./node-stat.js";

type Settings = { guest?: string }; // e.g. "lxc/106"

export function findGuest(snapshot: Snapshot | undefined, key: string | undefined): Guest | undefined {
	return snapshot?.ok && key ? snapshot.guests.find((g) => g.key === key) : undefined;
}

export function guestLabel(guest: Guest): string {
	return `${guest.type === "lxc" ? "LXC" : "VM"} ${guest.vmid}`;
}

/**
 * Key: one container or VM — status, CPU and RAM.
 * Press: open it in the Proxmox web UI. Hold: refresh.
 *
 * Deliberately view-only. Starting and stopping guests is done in the web UI,
 * where it takes a deliberate click and a confirmation, not a key a child can reach.
 */
@action({ UUID: "com.jere.proxmox-deck.guest" })
export class GuestKey extends LiveAction<Settings> {
	protected override link(settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		const guest = findGuest(snapshot, settings.guest);
		return snapshot?.ok && guest ? webUiUrl(snapshot.baseUrl, { type: guest.type, id: guest.vmid }) : undefined;
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isKey()) return;
		let image: string;
		if (!settings.guest) {
			image = messageKey("Guest", "Pick one in the key's settings", COLOURS.muted);
		} else {
			const problem = problemImage(snapshot);
			const guest = findGuest(snapshot, settings.guest);
			if (problem) image = problem;
			else if (!guest) image = messageKey(settings.guest.replace("/", " "), "Not found on this host", COLOURS.warn);
			else image = guestKey({ name: guest.name, kind: guestLabel(guest), status: guest.status, cpuPct: guest.cpuPct, memPct: guest.memPct });
		}
		await action.setImage(toDataUrl(image));
	}
}
