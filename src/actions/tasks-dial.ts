import { type Action, action, type DialRotateEvent, type FeedbackPayload } from "@elgato/streamdeck";

import { COLOURS, formatDuration, formatWhen, truncate } from "../proxmox/format.js";
import { type Feature, proxmox, type Snapshot, type Task, type TaskState } from "../proxmox/service.js";
import { LiveAction, wrapIndex } from "./live-action.js";
import { problemFeedback } from "./node-dial.js";
import { nodeLink } from "./node-stat.js";

type Filter = "all" | "backups" | "problems";
type Settings = { filter?: Filter; task?: string }; // task = UPID of the selected task

const STATE: Record<TaskState, { text: string; colour: string }> = {
	ok: { text: "OK", colour: COLOURS.ok },
	warn: { text: "Warnings", colour: COLOURS.warn },
	failed: { text: "Failed", colour: COLOURS.bad },
	running: { text: "Running…", colour: COLOURS.info },
};

function filtered(tasks: Task[], filter: Filter | undefined): Task[] {
	if (filter === "backups") return tasks.filter((t) => t.type === "vzdump");
	if (filter === "problems") return tasks.filter((t) => t.state === "failed" || t.state === "warn");
	return tasks;
}

/** "24h: 6 ok · 1 failed", counting only the last 24 hours. */
function summary(tasks: Task[]): { value: string; color: string } {
	const since = Date.now() / 1000 - 86_400;
	const recent = tasks.filter((t) => t.start >= since);
	const count = (state: TaskState) => recent.filter((t) => t.state === state).length;
	const failed = count("failed");
	const warn = count("warn");
	const parts = [`${count("ok")} ok`, warn ? `${warn} warning${warn === 1 ? "" : "s"}` : "", failed ? `${failed} failed` : "", count("running") ? `${count("running")} running` : ""];
	return { value: `24h: ${parts.filter(Boolean).join(" · ")}`, color: failed ? COLOURS.bad : warn ? COLOURS.warn : COLOURS.muted };
}

function describe(t: Task): string {
	if (t.state === "running") return `Started ${formatWhen(t.start)} · ${formatDuration(Date.now() / 1000 - t.start)}`;
	const took = t.end ? ` · took ${formatDuration(t.end - t.start)}` : "";
	if (t.state === "failed" || t.state === "warn") return `${formatWhen(t.start)} · ${t.status}`;
	return `${formatWhen(t.start)}${took}`;
}

/**
 * Dial: recent tasks on the host, newest first. Most useful set to "Backups":
 * a glance tells you whether last night's backup worked.
 * Turn: older / newer. Press: open the node (Task History lives there).
 * Hold, or tap the strip: refresh. Tasks are fetched only while this dial is
 * on screen, and at most every 30 seconds, since they change slowly.
 */
@action({ UUID: "com.jere.proxmox-deck.tasks-dial" })
export class TasksDial extends LiveAction<Settings> {
	protected override readonly needs: readonly Feature[] = ["tasks"];

	private selected(settings: Settings, snapshot: Snapshot | undefined): { list: Task[]; task?: Task; index: number } {
		const list = snapshot?.ok && snapshot.tasks ? filtered(snapshot.tasks, settings.filter) : [];
		const found = list.findIndex((t) => t.upid === settings.task);
		const index = found >= 0 ? found : 0;
		return { list, task: list[index], index };
	}

	protected override link(_settings: Settings, snapshot: Snapshot | undefined): string | undefined {
		return nodeLink(snapshot);
	}

	protected override async render(action: Action<Settings>, settings: Settings, snapshot: Snapshot | undefined): Promise<void> {
		if (!action.isDial()) return;
		const blank = { value: "", color: COLOURS.muted };
		const problem = problemFeedback(snapshot);
		if (problem) return action.setFeedback({ name: problem.name!, pos: "", value: problem.value!, detail: problem.detail!, summary: blank });
		if (!snapshot?.ok) return;

		const title = settings.filter === "backups" ? "Backups" : settings.filter === "problems" ? "Problems" : "Tasks";
		let feedback: FeedbackPayload;
		if (!snapshot.tasks) {
			feedback = { name: title, pos: "", value: { value: "…", color: COLOURS.muted }, detail: { value: "Loading tasks…", color: COLOURS.muted }, summary: blank };
		} else if (snapshot.tasksError && snapshot.tasks.length === 0) {
			feedback = { name: title, pos: "", value: { value: "No access", color: COLOURS.warn }, detail: { value: truncate(snapshot.tasksError, 34), color: COLOURS.warn }, summary: blank };
		} else {
			const { list, task, index } = this.selected(settings, snapshot);
			if (!task) {
				const allClear = settings.filter === "problems";
				feedback = {
					name: title,
					pos: "",
					value: { value: allClear ? "All clear" : "None", color: allClear ? COLOURS.ok : COLOURS.muted },
					detail: { value: allClear ? "No failed tasks recently" : settings.filter === "backups" ? "No recent backups" : "No recent tasks", color: COLOURS.muted },
					summary: blank,
				};
			} else {
				feedback = {
					// In Backups mode every entry is a backup, so the guest name alone reads better.
					name: settings.filter === "backups" && task.target ? task.target : task.label,
					pos: `${index + 1}/${list.length}`,
					value: { value: STATE[task.state].text, color: STATE[task.state].colour },
					detail: { value: describe(task), color: COLOURS.muted },
					summary: summary(list),
				};
			}
		}
		await action.setFeedback(feedback);
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const settings = this.settingsOf(ev.action.id);
		const { list, index } = this.selected(settings, proxmox.snapshot);
		if (list.length === 0) return;
		const next = list[wrapIndex(index + ev.payload.ticks, list.length)]!;
		await this.saveSettings(ev.action, { ...settings, task: next.upid });
		await this.draw(ev.action);
	}
}
