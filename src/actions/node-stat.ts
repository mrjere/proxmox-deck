import { type Action, action } from "@elgato/streamdeck";

import { COLOURS } from "../proxmox/format.js";
import { type NodeMetric, proxmox, type Snapshot, webUiUrl } from "../proxmox/service.js";
import { messageKey, statKey, toDataUrl } from "../render/key-images.js";
import { describeMetric } from "../render/metrics.js";
import { LiveAction } from "./live-action.js";

type Settings = { metric?: NodeMetric };

/** Shared by keys that need a "what's wrong" image. */
export function problemImage(snapshot: Snapshot | undefined): string | undefined {
	if (!snapshot) return messageKey("Proxmox", "Connecting…", COLOURS.muted);
	if (!snapshot.ok) return snapshot.configured ? messageKey("Proxmox", snapshot.error) : messageKey("Set up", snapshot.error, COLOURS.muted);
	return undefined;
}

export function nodeLink(snapshot: Snapshot | undefined): string | undefined {
	return snapshot?.ok && snapshot.node ? webUiUrl(snapshot.baseUrl, { type: "node", id: snapshot.node.name }) : undefined;
}

/**
 * Key: one host metric (CPU, RAM, disk, IO delay, swap, load, network, uptime)
 * with a sparkline. Press: open the node in the web UI. Hold: refresh.
 */
@action({ UUID: "com.jere.proxmox-deck.node-stat" })
export class NodeStatKey extends LiveAction<Settings> {
	protected override link(_settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		return nodeLink(snapshot);
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isKey()) return;
		let image = problemImage(snapshot);
		if (!image && snapshot?.ok) {
			const node = snapshot.node;
			if (!node) {
				image = messageKey("Proxmox", "No node found", COLOURS.warn);
			} else {
				const metric = settings.metric ?? "cpu";
				const view = describeMetric(node, metric, proxmox.history(`node:${metric}`));
				image = statKey({
					label: `${node.name} · ${view.short}`,
					value: view.value,
					colour: view.colour,
					detail: ["mem", "disk", "swap", "uptime"].includes(metric) ? view.detail : undefined,
					history: view.historyKey ? proxmox.history(view.historyKey) : [],
					historyMax: view.historyMax,
				});
			}
		}
		await action.setImage(toDataUrl(image!));
	}
}
