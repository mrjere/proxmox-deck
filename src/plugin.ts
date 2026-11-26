import streamDeck from "@elgato/streamdeck";

import { GuestDial } from "./actions/guest-dial.js";
import { GuestKey } from "./actions/guest-key.js";
import { NodeDial } from "./actions/node-dial.js";
import { NodeStatKey } from "./actions/node-stat.js";
import { StorageDial } from "./actions/storage-dial.js";
import { TasksDial } from "./actions/tasks-dial.js";
import { proxmox, ProxmoxService } from "./proxmox/service.js";
import type { GlobalSettings } from "./settings.js";

// "info", not "trace": trace logging records every message between Stream Deck
// and the plugin, which would include your API token in the log files.
streamDeck.logger.setLevel("info");

// Safety net. The SDK calls our async event handlers without awaiting them, so
// an error that escapes one becomes an "unhandled rejection", which by default
// makes Node.js exit. Stream Deck would then restart the plugin, which looks
// like a disconnect. Log it and keep running instead.
process.on("unhandledRejection", (reason) => streamDeck.logger.error("Unhandled promise rejection", reason));

streamDeck.actions.registerAction(new NodeStatKey());
streamDeck.actions.registerAction(new GuestKey());
streamDeck.actions.registerAction(new NodeDial());
streamDeck.actions.registerAction(new GuestDial());
streamDeck.actions.registerAction(new StorageDial());
streamDeck.actions.registerAction(new TasksDial());

// Poll failures go to the plugin's log file (never the token), so problems can be diagnosed.
proxmox.log = (level, message) => (level === "warn" ? streamDeck.logger.warn(message) : streamDeck.logger.info(message));

// Connection details changed in a settings page -> reconnect with the new ones.
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => proxmox.configure(ev.settings));

/**
 * Requests from the settings pages (ui/pi.js):
 *  - "test":  try the saved connection and report back
 *  - "lists": nodes and guests, to fill the drop-downs
 */
streamDeck.ui.onSendToPlugin(async (ev) => {
	const request = (ev.payload ?? {}) as { event?: string };

	if (request.event === "test") {
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		const result = await ProxmoxService.test(settings);
		await streamDeck.ui.sendToPropertyInspector({ event: "test", ...result });
	}

	if (request.event === "lists") {
		const snapshot = await proxmox.refresh();
		await streamDeck.ui.sendToPropertyInspector(
			snapshot.ok
				? {
						event: "lists",
						ok: true,
						nodes: snapshot.nodes,
						guests: snapshot.guests.map((g) => ({
							value: g.key,
							label: `${g.vmid} · ${g.name} (${g.type === "lxc" ? "LXC" : "VM"})`,
						})),
					}
				: { event: "lists", ok: false, error: snapshot.error },
		);
	}
});

await streamDeck.connect();
proxmox.configure(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
