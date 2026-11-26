/**
 * Describes a node metric for display. Shared by the key and the dial so they
 * always agree on wording, units and colours.
 */
import { COLOURS, formatBytesPair, formatPct, formatRate, formatUptime, levelColour } from "../proxmox/format.js";
import type { NodeInfo, NodeMetric } from "../proxmox/service.js";

export type MetricView = {
	short: string; // "CPU"
	value: string; // "23%"
	/** 0..100 for the bar; undefined hides the bar. */
	bar?: number;
	colour: string;
	detail: string;
	historyKey?: string;
	historyMax?: number;
};

export const METRIC_NAMES: Record<NodeMetric, string> = {
	cpu: "CPU",
	mem: "RAM",
	disk: "Disk",
	iowait: "IO delay",
	swap: "Swap",
	load: "Load",
	netin: "Net in",
	netout: "Net out",
	uptime: "Uptime",
};

export function describeMetric(node: NodeInfo, metric: NodeMetric, history: readonly number[] = []): MetricView {
	switch (metric) {
		case "cpu":
			return {
				short: METRIC_NAMES.cpu,
				value: formatPct(node.cpuPct),
				bar: node.cpuPct,
				colour: levelColour(node.cpuPct),
				detail: [node.cores ? `${node.cores} cores` : "", node.load1 !== undefined ? `load ${node.load1.toFixed(2)}` : ""].filter(Boolean).join(" · "),
				historyKey: "node:cpu",
				historyMax: 100,
			};
		case "mem":
			return {
				short: METRIC_NAMES.mem,
				value: formatPct(node.memPct),
				bar: node.memPct,
				colour: levelColour(node.memPct),
				detail: formatBytesPair(node.mem, node.maxmem),
				historyKey: "node:mem",
				historyMax: 100,
			};
		case "disk":
			return {
				short: METRIC_NAMES.disk,
				value: formatPct(node.diskPct),
				bar: node.diskPct,
				colour: levelColour(node.diskPct),
				detail: `root ${formatBytesPair(node.disk, node.maxdisk, 0)}`,
				historyKey: "node:disk",
				historyMax: 100,
			};
		case "iowait":
			// IO delay = time the CPU spent waiting on disks. A few % is normal;
			// sustained double digits means storage is the bottleneck.
			return {
				short: METRIC_NAMES.iowait,
				value: formatPct(node.iowaitPct),
				bar: node.iowaitPct,
				colour: levelColour(node.iowaitPct, 10, 25),
				detail: "waiting on disks",
				historyKey: "node:iowait",
				historyMax: Math.max(10, ...history),
			};
		case "swap":
			if (!node.maxswap) {
				return { short: METRIC_NAMES.swap, value: "None", colour: COLOURS.muted, detail: "no swap configured" };
			}
			return {
				short: METRIC_NAMES.swap,
				value: formatPct(node.swapPct),
				bar: node.swapPct,
				colour: levelColour(node.swapPct),
				detail: formatBytesPair(node.swap, node.maxswap),
				historyKey: "node:swap",
				historyMax: 100,
			};
		case "load": {
			// Load ÷ cores ≈ how saturated the CPU is; >100% means work is queuing.
			const saturation = node.load1 !== undefined && node.cores ? (node.load1 / node.cores) * 100 : undefined;
			return {
				short: METRIC_NAMES.load,
				value: node.load1 === undefined ? "–" : node.load1.toFixed(2),
				bar: saturation,
				colour: levelColour(saturation),
				detail: node.cores ? `1-min avg · ${node.cores} cores` : "1-min average",
				historyKey: "node:load",
			};
		}
		case "netin":
		case "netout": {
			const value = metric === "netin" ? node.netIn : node.netOut;
			// No fixed maximum for network, so scale the bar to the recent peak.
			const peak = Math.max(...history, value ?? 0, 1);
			return {
				short: METRIC_NAMES[metric],
				value: formatRate(value),
				bar: value === undefined ? undefined : (value / peak) * 100,
				colour: COLOURS.info,
				detail: "1-min average",
				historyKey: `node:${metric}`,
			};
		}
		case "uptime":
			return {
				short: METRIC_NAMES.uptime,
				value: formatUptime(node.uptime),
				colour: node.status === "online" ? COLOURS.ok : COLOURS.warn,
				detail: node.status,
			};
	}
}
