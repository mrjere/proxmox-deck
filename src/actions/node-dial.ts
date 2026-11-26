import { type Action, action, type DialRotateEvent, type FeedbackPayload } from "@elgato/streamdeck";

import { COLOURS, truncate } from "../proxmox/format.js";
import { NODE_METRICS, type NodeMetric, proxmox, type Snapshot } from "../proxmox/service.js";
import { describeMetric } from "../render/metrics.js";
import { LiveAction, wrapIndex } from "./live-action.js";
import { nodeLink } from "./node-stat.js";

type Settings = { metric?: NodeMetric };

/**
 * Feedback for the shared name/pos/value/bar/detail layout when there's
 * nothing to show yet (connecting, not set up, offline).
 */
export function problemFeedback(snapshot: Snapshot | undefined): FeedbackPayload | undefined {
	if (snapshot?.ok) return undefined;
	const configured = snapshot ? snapshot.configured : true;
	const message = snapshot ? snapshot.error : "Connecting…";
	const colour = configured && snapshot ? COLOURS.bad : COLOURS.muted;
	return {
		name: configured ? "Proxmox" : "Set up",
		pos: "",
		value: { value: snapshot ? (configured ? "Offline" : "Settings") : "…", color: colour },
		detail: { value: truncate(message, 34), color: colour },
		bar: { enabled: false },
	};
}

/**
 * Dial: the host at a glance.
 * Turn: cycle CPU → RAM → disk → IO delay → swap → load → net in → net out → uptime.
 * Press: open the node in the web UI. Hold, or tap the strip: refresh.
 */
@action({ UUID: "com.jere.proxmox-deck.node-dial" })
export class NodeDial extends LiveAction<Settings> {
	protected override link(_settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		return nodeLink(snapshot);
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isDial()) return;
		const problem = problemFeedback(snapshot);
		if (problem) return action.setFeedback(problem);
		if (!snapshot?.ok || !snapshot.node) return action.setFeedback(problemFeedback({ ok: false, at: 0, configured: true, error: "No node found" })!);

		const metric = settings.metric ?? "cpu";
		const node = snapshot.node;
		const view = describeMetric(node, metric, proxmox.history(`node:${metric}`));
		await action.setFeedback({
			name: `${node.name} · ${view.short}`,
			pos: `${NODE_METRICS.indexOf(metric) + 1}/${NODE_METRICS.length}`,
			value: { value: view.value, color: view.colour },
			bar: view.bar === undefined ? { enabled: false } : { enabled: true, value: Math.round(view.bar), bar_fill_c: view.colour },
			detail: { value: view.detail, color: COLOURS.muted },
		});
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const settings = this.settingsOf(ev.action.id);
		const current = Math.max(0, NODE_METRICS.indexOf(settings.metric ?? "cpu"));
		const metric = NODE_METRICS[wrapIndex(current + ev.payload.ticks, NODE_METRICS.length)]!;
		await this.saveSettings(ev.action, { ...settings, metric });
		await this.draw(ev.action);
	}
}
