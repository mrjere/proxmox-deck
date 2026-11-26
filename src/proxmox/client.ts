import type https from "node:https";

import type { ConnectionConfig } from "../settings.js";
import { createAgent, request } from "./http.js";

/** One row of GET /cluster/resources (only the fields we use). */
export type ClusterResource = {
	id: string; // "node/pve", "lxc/106", "qemu/100", "storage/pve/local"
	type: "node" | "qemu" | "lxc" | "storage" | "sdn" | "pool" | string;
	node?: string;
	status?: string; // "running", "stopped", "online", "available", ...
	name?: string;
	vmid?: number;
	template?: number; // 1 for templates
	cpu?: number; // fraction, 0..1 (of the allocated cores for guests)
	maxcpu?: number;
	mem?: number; // bytes
	maxmem?: number;
	disk?: number;
	maxdisk?: number;
	uptime?: number; // seconds
	// Storage rows only:
	storage?: string; // "local", "local-lvm", "nas-backups"
	plugintype?: string; // "dir", "lvmthin", "zfspool", "cifs", "nfs", ...
	content?: string; // "iso,vztmpl,backup"
	shared?: number; // 1 if every node can see it (e.g. a NAS share)
};

/** GET /nodes/{node}/status (only the fields we use). */
export type NodeStatus = {
	cpu: number;
	/** Share of time the CPU sat waiting for disk I/O, as a fraction like `cpu` (the UI's "IO delay"). */
	wait?: number;
	loadavg?: string[];
	memory?: { used: number; total: number };
	swap?: { used: number; total: number };
	rootfs?: { used: number; total: number };
	uptime?: number;
	cpuinfo?: { cpus?: number; model?: string };
};

/** One sample of GET /nodes/{node}/rrddata. Values are averages over the sample period. */
export type RrdPoint = { time: number; netin?: number; netout?: number };

/** One row of GET /nodes/{node}/tasks. */
export type TaskRow = {
	upid: string;
	type: string; // "vzdump", "qmstart", "aptupdate", ...
	id?: string; // usually the VMID, or "" for node-wide tasks
	node: string;
	user?: string;
	starttime: number; // unix seconds
	endtime?: number; // missing while running
	status?: string; // "OK", "WARNINGS: 2", an error message, or "RUNNING"
};

export type GuestType = "lxc" | "qemu";

/**
 * Thin, typed wrapper around the handful of API endpoints the plugin needs.
 *
 * Every method here only READS. The plugin deliberately has no way to change
 * anything on your server (no start/stop, no config). Even if a bug or a
 * curious toddler pressed every key, nothing on Proxmox can change.
 */
export class ProxmoxClient {
	private readonly agent: https.Agent;

	constructor(readonly config: ConnectionConfig) {
		this.agent = createAgent(config);
	}

	private get<T>(path: string): Promise<T> {
		return request<T>(this.config, this.agent, path);
	}

	/** Every node, VM, container and storage in one call. Needs Sys.Audit, VM.Audit, Datastore.Audit. */
	resources(): Promise<ClusterResource[]> {
		return this.get<ClusterResource[]>("/cluster/resources");
	}

	nodeStatus(node: string): Promise<NodeStatus> {
		return this.get<NodeStatus>(`/nodes/${encodeURIComponent(node)}/status`);
	}

	/** Recent history for the node; we only use it for network throughput. */
	nodeRrd(node: string): Promise<RrdPoint[]> {
		return this.get<RrdPoint[]>(`/nodes/${encodeURIComponent(node)}/rrddata?timeframe=hour&cf=AVERAGE`);
	}

	/** Recent tasks on a node (backups, starts, updates...), finished and running. */
	tasks(node: string, limit = 100): Promise<TaskRow[]> {
		return this.get<TaskRow[]>(`/nodes/${encodeURIComponent(node)}/tasks?source=all&limit=${limit}`);
	}

	/** Closes pooled connections, e.g. when settings change. */
	dispose(): void {
		this.agent.destroy();
	}
}
