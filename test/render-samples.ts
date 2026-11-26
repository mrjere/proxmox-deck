/**
 * Renders sample key images and approximate touch-strip previews to test/out,
 * so the visuals can be checked without a Stream Deck. The strip preview is a
 * rough simulation of Stream Deck's layout engine (text + bars only).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { describeMetric } from "../src/render/metrics.js";
import { guestKey, messageKey, statKey } from "../src/render/key-images.js";
import { COLOURS, formatPct, levelColour, statusColour, xml } from "../src/proxmox/format.js";
import type { NodeInfo } from "../src/proxmox/service.js";

mkdirSync("test/out", { recursive: true });
const out = (name: string, svg: string) => writeFileSync(`test/out/${name}.svg`, svg);

const node: NodeInfo = {
	name: "pve", status: "online", cpuPct: 23.4, cores: 8, load1: 0.42, mem: 12.5 * 2 ** 30, maxmem: 31.2 * 2 ** 30, memPct: 40,
	disk: 18 * 2 ** 30, maxdisk: 94 * 2 ** 30, diskPct: 19, uptime: 3 * 86400 + 4 * 3600, netIn: 1_250_000, netOut: 62_500,
};
const cpuHistory = [12, 15, 14, 22, 35, 28, 19, 23, 41, 38, 30, 26, 22, 25, 23, 21, 24, 23];
const memHistory = cpuHistory.map((v) => 85 + v / 6);

let v = describeMetric(node, "cpu");
out("key-cpu", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, history: cpuHistory, historyMax: 100 }));
v = describeMetric({ ...node, memPct: 92, mem: 28.7 * 2 ** 30 }, "mem");
out("key-mem-high", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, detail: v.detail, history: memHistory, historyMax: 100 }));
v = describeMetric(node, "netin", [400_000, 900_000, 1_250_000]);
out("key-netin", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, history: [400_000, 900_000, 700_000, 1_250_000] }));
v = describeMetric(node, "uptime");
out("key-uptime", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, detail: v.detail, history: [] }));
out("key-guest-running", guestKey({ name: "audiobookshelf", kind: "LXC 106", status: "running", cpuPct: 4.2, memPct: 20 }));
out("key-guest-busy", guestKey({ name: "jellyfin", kind: "LXC 105", status: "running", cpuPct: 78, memPct: 93 }));
out("key-guest-stopped", guestKey({ name: "homeassistant", kind: "VM 100", status: "stopped" }));
v = describeMetric({ ...node, iowaitPct: 3.1 }, "iowait", [1, 2, 3.1, 2.4, 6, 3]);
out("key-iowait", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, history: [1, 2, 3.1, 2.4, 6, 3, 2, 3.1], historyMax: v.historyMax }));
v = describeMetric({ ...node, swap: 2 ** 30, maxswap: 8 * 2 ** 30, swapPct: 12.5 }, "swap");
out("key-swap", statKey({ label: `pve · ${v.short}`, value: v.value, colour: v.colour, detail: v.detail, history: [12, 12.5, 12.5], historyMax: 100 }));
out("key-error", messageKey("Proxmox", "Untrusted certificate. Add its fingerprint"));
out("key-setup", messageKey("Set up", "Add your Proxmox host", COLOURS.muted));

// ---- Touch strip simulation ----
type Item = { key: string; type: string; rect: [number, number, number, number]; font?: { size?: number; weight?: number }; alignment?: string; color?: string; value?: unknown; bar_bg_c?: string; bar_fill_c?: string; enabled?: boolean };
function strip(layoutPath: string, feedback: Record<string, unknown>): string {
	const layout = JSON.parse(readFileSync(layoutPath, "utf8")) as { items: Item[] };
	let body = "";
	for (const base of layout.items) {
		const fb = feedback[base.key];
		const item: Item = { ...base, ...(typeof fb === "object" && fb !== null ? fb : fb !== undefined ? { value: fb } : {}) };
		if (item.enabled === false) continue;
		const [x, y, w, h] = item.rect;
		if (item.type === "text") {
			const size = item.font?.size ?? 16;
			const anchor = item.alignment === "left" ? "start" : item.alignment === "right" ? "end" : "middle";
			const tx = anchor === "start" ? x : anchor === "end" ? x + w : x + w / 2;
			body += `<clipPath id="c-${item.key}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`;
			body += `<text clip-path="url(#c-${item.key})" x="${tx}" y="${y + h / 2 + size * 0.35}" font-family="Arial" font-size="${size}" font-weight="${item.font?.weight ?? 400}" fill="${item.color ?? "white"}" text-anchor="${anchor}">${xml(String(item.value ?? ""))}</text>`;
		} else if (item.type === "bar") {
			const value = Number(item.value ?? 0);
			body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${item.bar_bg_c ?? "darkgray"}"/>`;
			if (value > 0) body += `<rect x="${x}" y="${y}" width="${(w * Math.min(100, value)) / 100}" height="${h}" rx="${h / 2}" fill="${item.bar_fill_c ?? "white"}"/>`;
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#000"/>${body}</svg>`;
}

const nodeLayout = "com.jere.proxmox-deck.sdPlugin/layouts/stat-dial.json";
const tasksLayout = "com.jere.proxmox-deck.sdPlugin/layouts/tasks-dial.json";
const guestLayout = "com.jere.proxmox-deck.sdPlugin/layouts/guest-dial.json";
v = describeMetric(node, "cpu");
out("strip-node-cpu", strip(nodeLayout, { name: "pve · CPU", pos: "1/9", value: { value: v.value, color: v.colour }, bar: { value: Math.round(v.bar!), bar_fill_c: v.colour }, detail: v.detail }));
v = describeMetric(node, "mem");
out("strip-node-mem", strip(nodeLayout, { name: "pve · RAM", pos: "2/7", value: { value: v.value, color: v.colour }, bar: { value: Math.round(v.bar!), bar_fill_c: v.colour }, detail: v.detail }));
v = describeMetric(node, "netin", [1_250_000, 2_000_000]);
out("strip-node-netin", strip(nodeLayout, { name: "pve · Net in", pos: "5/7", value: { value: v.value, color: v.colour }, bar: { value: Math.round(v.bar!), bar_fill_c: v.colour }, detail: v.detail }));
out("strip-node-error", strip(nodeLayout, { name: "Proxmox", pos: "", value: { value: "Offline", color: COLOURS.bad }, bar: { enabled: false }, detail: { value: "Connection refused. Check host and port", color: COLOURS.bad } }));
out("strip-guest", strip(guestLayout, { name: "audiobookshelf", pos: "3/7", sub: { value: "LXC 106 · running · 2d 0h", color: statusColour("running") }, cpu: { value: 4, bar_fill_c: levelColour(4.2) }, cpu_val: formatPct(4.2), mem: { value: 20, bar_fill_c: levelColour(20) }, mem_val: formatPct(20) }));
out("strip-guest-busy", strip(guestLayout, { name: "jellyfin-transcoder-01", pos: "2/7", sub: { value: "LXC 105 · running · 5h 0m", color: statusColour("running") }, cpu: { value: 78, bar_fill_c: levelColour(78) }, cpu_val: formatPct(78), mem: { value: 93, bar_fill_c: levelColour(93) }, mem_val: formatPct(93) }));
out("strip-guest-stopped", strip(guestLayout, { name: "homeassistant", pos: "1/7", sub: { value: "VM 100 · stopped", color: statusColour("stopped") }, cpu: { value: 0 }, cpu_val: "–", mem: { value: 0 }, mem_val: "–" }));
out("strip-node-refreshed", strip(nodeLayout, { name: "pve · CPU", pos: "1/9", value: { value: "23%", color: COLOURS.ok }, bar: { value: 23, bar_fill_c: COLOURS.ok }, detail: { value: "✓ Refreshed", color: COLOURS.ok } }));
out("strip-storage", strip(nodeLayout, { name: "local-lvm", pos: "2/3", value: { value: "83%", color: COLOURS.warn }, bar: { value: 83, bar_fill_c: COLOURS.warn }, detail: { value: "150.0 / 180.0 GiB · lvmthin", color: COLOURS.muted } }));
out("strip-storage-offline", strip(nodeLayout, { name: "nas-backups · shared", pos: "3/3", value: { value: "Offline", color: COLOURS.bad }, bar: { enabled: false }, detail: { value: "cifs · unknown", color: COLOURS.muted } }));
out("strip-tasks-running", strip(tasksLayout, { name: "Backup · jellyfin", pos: "1/3", value: { value: "Running…", color: COLOURS.info }, detail: { value: "Started Today 15:58 · 2m 0s", color: COLOURS.muted }, summary: { value: "24h: 1 ok · 1 failed · 1 running", color: COLOURS.bad } }));
out("strip-tasks-failed", strip(tasksLayout, { name: "Backup · homeassistant", pos: "3/3", value: { value: "Failed", color: COLOURS.bad }, detail: { value: "Today 09:50 · job errors", color: COLOURS.muted }, summary: { value: "24h: 1 ok · 1 failed · 1 running", color: COLOURS.bad } }));
out("strip-tasks-ok", strip(tasksLayout, { name: "Backup · audiobookshelf", pos: "2/3", value: { value: "OK", color: COLOURS.ok }, detail: { value: "Today 10:00 · took 4m 12s", color: COLOURS.muted }, summary: { value: "24h: 1 ok · 1 failed · 1 running", color: COLOURS.bad } }));
console.log("wrote test/out/*.svg");
