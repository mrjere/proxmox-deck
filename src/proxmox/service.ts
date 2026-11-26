import { type GlobalSettings, pollIntervalMs, toConnectionConfig } from "../settings.js";
import { type ClusterResource, type GuestType, ProxmoxClient, type RrdPoint, type TaskRow } from "./client.js";
import { pct } from "./format.js";
import { ApiError } from "./http.js";

export type NodeMetric = "cpu" | "mem" | "disk" | "iowait" | "swap" | "load" | "netin" | "netout" | "uptime";
export const NODE_METRICS: readonly NodeMetric[] = ["cpu", "mem", "disk", "iowait", "swap", "load", "netin", "netout", "uptime"];

export type NodeInfo = {
	name: string;
	status: string;
	cpuPct?: number;
	cores?: number;
	load1?: number;
	iowaitPct?: number;
	mem?: number;
	maxmem?: number;
	memPct?: number;
	swap?: number;
	maxswap?: number;
	swapPct?: number;
	disk?: number;
	maxdisk?: number;
	diskPct?: number;
	uptime?: number;
	netIn?: number; // bytes/s, 1-minute average
	netOut?: number;
};

export type Guest = {
	/** Stable key used in settings, e.g. "lxc/106". */
	key: string;
	type: GuestType;
	vmid: number;
	name: string;
	node: string;
	status: string;
	cpuPct?: number;
	cores?: number;
	mem?: number;
	maxmem?: number;
	memPct?: number;
	uptime?: number;
};

export type Storage = {
	key: string; // "storage/pve/local"
	name: string; // "local"
	node: string;
	type: string; // "dir", "zfspool", "cifs", ...
	status: string; // "available" when healthy
	used?: number;
	total?: number;
	usedPct?: number;
	shared: boolean;
	content: string[];
};

export type TaskState = "ok" | "warn" | "failed" | "running";
export type Task = {
	upid: string;
	type: string;
	label: string; // "Backup · jellyfin"
	target?: string; // "jellyfin" (the guest's name, or the raw ID)
	state: TaskState;
	status: string; // raw status text from Proxmox
	start: number; // unix seconds
	end?: number;
};

export type Snapshot =
	| {
			ok: true;
			at: number;
			baseUrl: string;
			node?: NodeInfo;
			nodes: string[];
			guests: Guest[];
			storages: Storage[];
			/** Only present while something on screen wants tasks. */
			tasks?: Task[];
			tasksError?: string;
	  }
	| { ok: false; at: number; error: string; configured: boolean };

/** Optional extra data an action can ask for; fetched only while someone wants it. */
export type Feature = "tasks";

type Listener = (snapshot: Snapshot) => void;
type Subscription = { listener: Listener; needs: readonly Feature[] };

const HISTORY_LENGTH = 36; // 36 samples x 5s = the last 3 minutes

/**
 * How many polls in a row must fail before keys show "offline". One blip
 * (a dropped packet, Proxmox busy for a moment) shouldn't flash the whole
 * deck red; we keep showing the last good numbers until it's clearly down.
 * This is called hysteresis, and it's how most monitoring tools avoid "flapping".
 */
const FAILURES_BEFORE_OFFLINE = 2;

/** Tasks change slowly; fetching them every 5 seconds would be wasted work. */
const TASKS_EVERY_MS = 30_000;

/** Console/shell sessions are tasks too, but they're noise on a status dial. */
const NOISY_TASKS = new Set(["vncproxy", "vncshell", "termproxy", "spiceproxy"]);

const TASK_NAMES: Record<string, string> = {
	vzdump: "Backup",
	qmstart: "VM start",
	qmstop: "VM stop",
	qmshutdown: "VM shutdown",
	qmreboot: "VM reboot",
	qmsnapshot: "Snapshot",
	qmrollback: "Rollback",
	qmclone: "Clone",
	qmcreate: "VM create",
	qmdestroy: "VM destroy",
	qmigrate: "VM migrate",
	vzstart: "CT start",
	vzstop: "CT stop",
	vzshutdown: "CT shutdown",
	vzreboot: "CT reboot",
	vzsnapshot: "Snapshot",
	vzrollback: "Rollback",
	vzcreate: "CT create",
	vzdestroy: "CT destroy",
	vzmigrate: "CT migrate",
	aptupdate: "Update check",
	startall: "Start all",
	stopall: "Stop all",
	srvreload: "Service reload",
	srvrestart: "Service restart",
	imgdel: "Delete image",
	download: "Download",
	vncproxy: "Console",
	vncshell: "Shell",
	termproxy: "Shell",
	spiceproxy: "Console",
};

export type LogFn = (level: "info" | "warn", message: string) => void;

function toGuest(r: ClusterResource): Guest {
	return {
		key: `${r.type}/${r.vmid}`,
		type: r.type as GuestType,
		vmid: r.vmid ?? 0,
		name: r.name ?? `${r.type} ${r.vmid}`,
		node: r.node ?? "",
		status: r.status ?? "unknown",
		cpuPct: r.cpu === undefined ? undefined : r.cpu * 100,
		cores: r.maxcpu,
		mem: r.mem,
		maxmem: r.maxmem,
		memPct: pct(r.mem, r.maxmem),
		uptime: r.uptime,
	};
}

function toStorage(r: ClusterResource): Storage {
	return {
		key: r.id,
		name: r.storage ?? r.id.split("/").pop() ?? r.id,
		node: r.node ?? "",
		type: r.plugintype ?? "storage",
		status: r.status ?? "unknown",
		used: r.disk,
		total: r.maxdisk,
		usedPct: pct(r.disk, r.maxdisk),
		shared: r.shared === 1,
		content: (r.content ?? "").split(",").filter(Boolean),
	};
}

export function taskState(row: Pick<TaskRow, "status" | "endtime">): TaskState {
	const status = row.status ?? "";
	if (status === "RUNNING" || (!row.endtime && !status)) return "running";
	if (status === "OK") return "ok";
	if (status.startsWith("WARNINGS")) return "warn";
	return "failed";
}

function toTask(row: TaskRow, guests: Guest[]): Task {
	const name = TASK_NAMES[row.type] ?? row.type;
	const vmid = row.id ? Number(row.id) : NaN;
	const guest = Number.isFinite(vmid) ? guests.find((g) => g.vmid === vmid) : undefined;
	const target = guest?.name ?? (row.id || "");
	return {
		upid: row.upid,
		type: row.type,
		label: target ? `${name} · ${target}` : name,
		target: target || undefined,
		state: taskState(row),
		status: row.status ?? "RUNNING",
		start: row.starttime,
		end: row.endtime,
	};
}

/** Most recent RRD sample that actually has data (the newest one is often still empty). */
function latestRrd(points: RrdPoint[]): RrdPoint | undefined {
	for (let i = points.length - 1; i >= 0; i--) {
		const p = points[i]!;
		if (typeof p.netin === "number" || typeof p.netout === "number") return p;
	}
	return undefined;
}

/**
 * One shared poller for the whole plugin.
 *
 * Every key and dial subscribes to this instead of calling Proxmox itself. With
 * eight tiles on screen that's still one set of requests every few seconds,
 * not eight. Polling only runs while at least one action is visible, and
 * optional extras (like tasks) are only fetched while something wants them.
 */
export class ProxmoxService {
	private settings: GlobalSettings = {};
	private client?: ProxmoxClient;
	private timer?: NodeJS.Timeout;
	private inFlight?: Promise<Snapshot>;
	private readonly subscriptions = new Set<Subscription>();
	private readonly series = new Map<string, number[]>();
	private last?: Snapshot;
	/** False until the saved settings have been loaded; avoids flashing "Set up" at start-up. */
	private ready = false;
	private failures = 0;
	private tasksCache?: { at: number; tasks: Task[]; error?: string };
	private forceExtras = false;
	/** What went wrong on the most recent poll (undefined if it worked), even when hysteresis hides it. */
	lastError?: string;
	/** Optional logger (the plugin points this at the Stream Deck log file). */
	log?: LogFn;

	/** Called on start-up and whenever the global settings change. */
	configure(settings: GlobalSettings): void {
		this.ready = true;
		this.settings = settings;
		this.client?.dispose();
		const config = toConnectionConfig(settings);
		this.client = typeof config === "string" ? undefined : new ProxmoxClient(config);
		this.series.clear();
		this.last = undefined;
		this.failures = 0;
		this.tasksCache = undefined;
		this.reschedule();
		if (this.subscriptions.size > 0) void this.refresh();
	}

	get snapshot(): Snapshot | undefined {
		return this.last;
	}

	/** Recent values for a metric, oldest first, e.g. history("node:cpu"). */
	history(key: string): readonly number[] {
		return this.series.get(key) ?? [];
	}

	private wants(feature: Feature): boolean {
		for (const s of this.subscriptions) if (s.needs.includes(feature)) return true;
		return false;
	}

	/** Subscribe to updates, optionally asking for extra data. Returns a function that unsubscribes. */
	subscribe(listener: Listener, needs: readonly Feature[] = []): () => void {
		const subscription: Subscription = { listener, needs };
		this.subscriptions.add(subscription);
		if (this.last) listener(this.last);
		const newNeed = needs.some((n) => n === "tasks" && !this.tasksCache);
		if (this.subscriptions.size === 1 || newNeed) {
			this.reschedule();
			void this.refresh();
		}
		return () => {
			this.subscriptions.delete(subscription);
			if (this.subscriptions.size === 0) this.reschedule();
		};
	}

	/**
	 * Poll now. If a poll is already running we share it rather than starting
	 * another; if Proxmox is slow, requests shouldn't pile up behind each other.
	 * `force` also re-fetches the slow-changing extras (used by manual refresh).
	 */
	refresh(options: { force?: boolean } = {}): Promise<Snapshot> {
		if (!this.ready) return Promise.resolve({ ok: false, at: Date.now(), configured: true, error: "Connecting…" });
		if (options.force) {
			this.forceExtras = true;
			// A forced refresh must see fresh data, so wait out any poll already running.
			if (this.inFlight) return this.inFlight.then(() => this.refresh(options));
		}
		this.inFlight ??= this.poll().finally(() => (this.inFlight = undefined));
		return this.inFlight;
	}

	private reschedule(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		if (this.ready && this.subscriptions.size > 0) {
			this.timer = setInterval(() => void this.refresh(), pollIntervalMs(this.settings));
		}
	}

	private record(key: string, value: number | undefined): void {
		if (value === undefined || !Number.isFinite(value)) return;
		const values = this.series.get(key) ?? [];
		values.push(value);
		if (values.length > HISTORY_LENGTH) values.shift();
		this.series.set(key, values);
	}

	private async poll(): Promise<Snapshot> {
		const client = this.client;
		let snapshot: Snapshot;
		let failure: string | undefined;

		if (!client) {
			const reason = toConnectionConfig(this.settings);
			snapshot = { ok: false, at: Date.now(), configured: false, error: typeof reason === "string" ? reason : "Not configured" };
		} else {
			try {
				snapshot = await this.fetch(client);
			} catch (err) {
				failure = err instanceof Error ? err.message : String(err);
				snapshot = { ok: false, at: Date.now(), configured: true, error: failure };
			}
		}

		// Settings may have changed while we were waiting; drop stale results.
		if (client !== this.client) return this.last ?? snapshot;
		this.lastError = snapshot.ok ? undefined : snapshot.error;

		if (failure !== undefined) {
			this.failures++;
			this.log?.("warn", `Poll failed (${this.failures} in a row): ${failure}`);
			// First failure after good data: keep showing the good data.
			if (this.failures < FAILURES_BEFORE_OFFLINE && this.last?.ok) return this.last;
		} else if (client) {
			if (this.failures >= FAILURES_BEFORE_OFFLINE) this.log?.("info", `Connection restored after ${this.failures} failed polls`);
			this.failures = 0;
		}

		this.last = snapshot;
		for (const { listener } of this.subscriptions) {
			try {
				listener(snapshot);
			} catch {
				// One broken listener mustn't stop the others updating.
			}
		}
		return snapshot;
	}

	private async fetch(client: ProxmoxClient): Promise<Snapshot> {
		const force = this.forceExtras;
		this.forceExtras = false;

		const resources = await client.resources();
		const nodes = resources.filter((r) => r.type === "node" && r.node).map((r) => r.node!);
		nodes.sort();

		const wanted = this.settings.node?.trim();
		if (wanted && !nodes.includes(wanted)) throw new ApiError(`Node "${wanted}" not found`);
		const nodeName = wanted || nodes[0];

		const guests = resources
			.filter((r) => (r.type === "lxc" || r.type === "qemu") && r.vmid !== undefined && r.template !== 1)
			.map(toGuest)
			.sort((a, b) => a.vmid - b.vmid);

		// Storage comes free with the resources call: no extra request.
		const storages = resources
			.filter((r) => r.type === "storage" && (!nodeName || r.node === nodeName))
			.map(toStorage)
			.sort((a, b) => a.name.localeCompare(b.name));

		let node: NodeInfo | undefined;
		let tasks: Task[] | undefined;
		let tasksError: string | undefined;

		if (nodeName) {
			const summary = resources.find((r) => r.type === "node" && r.node === nodeName);
			const wantTasks = this.wants("tasks");
			const tasksDue = wantTasks && (force || !this.tasksCache || Date.now() - this.tasksCache.at >= TASKS_EVERY_MS);

			// Detail calls are "nice to have": if they fail we still show the summary.
			const [status, rrd, taskRows] = await Promise.all([
				client.nodeStatus(nodeName).catch(() => undefined),
				client.nodeRrd(nodeName).catch(() => undefined),
				tasksDue ? client.tasks(nodeName).catch((err: unknown) => err as Error) : Promise.resolve(undefined),
			]);

			if (taskRows instanceof Error) {
				this.tasksCache = { at: Date.now(), tasks: this.tasksCache?.tasks ?? [], error: taskRows.message };
			} else if (taskRows) {
				const list = taskRows
					.filter((t) => !NOISY_TASKS.has(t.type))
					.map((t) => toTask(t, guests))
					.sort((a, b) => b.start - a.start);
				this.tasksCache = { at: Date.now(), tasks: list };
			}
			if (wantTasks && this.tasksCache) {
				tasks = this.tasksCache.tasks;
				tasksError = this.tasksCache.error;
			}

			const net = rrd ? latestRrd(rrd) : undefined;
			const mem = status?.memory?.used ?? summary?.mem;
			const maxmem = status?.memory?.total ?? summary?.maxmem;
			const disk = status?.rootfs?.used ?? summary?.disk;
			const maxdisk = status?.rootfs?.total ?? summary?.maxdisk;
			const cpu = status?.cpu ?? summary?.cpu;

			node = {
				name: nodeName,
				status: summary?.status ?? "unknown",
				cpuPct: cpu === undefined ? undefined : cpu * 100,
				cores: status?.cpuinfo?.cpus ?? summary?.maxcpu,
				load1: status?.loadavg?.[0] === undefined ? undefined : Number(status.loadavg[0]),
				// `wait` is a fraction, like `cpu`; the web UI shows it as "IO delay".
				iowaitPct: status?.wait === undefined ? undefined : status.wait * 100,
				mem,
				maxmem,
				memPct: pct(mem, maxmem),
				swap: status?.swap?.used,
				maxswap: status?.swap?.total,
				swapPct: pct(status?.swap?.used, status?.swap?.total),
				disk,
				maxdisk,
				diskPct: pct(disk, maxdisk),
				uptime: status?.uptime ?? summary?.uptime,
				netIn: net?.netin,
				netOut: net?.netout,
			};

			this.record("node:cpu", node.cpuPct);
			this.record("node:mem", node.memPct);
			this.record("node:disk", node.diskPct);
			this.record("node:iowait", node.iowaitPct);
			this.record("node:swap", node.swapPct);
			this.record("node:load", node.load1);
			this.record("node:netin", node.netIn);
			this.record("node:netout", node.netOut);
		}

		return { ok: true, at: Date.now(), baseUrl: client.config.baseUrl, node, nodes, guests, storages, tasks, tasksError };
	}

	/** One-off check used by the settings page's "Test connection" button. */
	static async test(settings: GlobalSettings): Promise<{ ok: boolean; message: string }> {
		const config = toConnectionConfig(settings);
		if (typeof config === "string") return { ok: false, message: config };
		const client = new ProxmoxClient(config);
		try {
			const resources = await client.resources();
			const nodes = resources.filter((r) => r.type === "node").length;
			const guests = resources.filter((r) => r.type === "lxc" || r.type === "qemu").length;
			return { ok: true, message: `Connected: ${nodes} node${nodes === 1 ? "" : "s"}, ${guests} guest${guests === 1 ? "" : "s"}` };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		} finally {
			client.dispose();
		}
	}
}

/** Web UI link. The fragment opens the item's page; if Proxmox changes the format it simply opens the dashboard. */
export function webUiUrl(baseUrl: string, target?: { type: string; id: string | number }): string {
	return target ? `${baseUrl}/#v1:0:=${encodeURIComponent(`${target.type}/${target.id}`)}` : `${baseUrl}/`;
}

export const proxmox = new ProxmoxService();
