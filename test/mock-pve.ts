/**
 * A tiny fake Proxmox API over HTTPS with a self-signed certificate, so the
 * client can be tested without a real server. It records every request so the
 * tests can check what was (and wasn't) sent.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN_ID = "streamdeck@pve!deck";
export const TOKEN_SECRET = "11111111-2222-3333-4444-555555555555";

export type Recorded = { method: string; path: string; auth?: string; dropped?: boolean };

export type MockPve = {
	url: string;
	port: number;
	fingerprint: string;
	requests: Recorded[];
	guests: Record<string, { status: string }>;
	/** Fault injection: `down` resets every connection; `dropReused` resets the next N requests that arrive on a reused (keep-alive) connection. */
	control: { down: boolean; dropReused: number; tasksForbidden: boolean };
	close(): Promise<void>;
};

function makeCert(): { key: string; cert: string } {
	const dir = mkdtempSync(join(tmpdir(), "mockpve-"));
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
		"-subj", "/CN=pve.mock", "-addext", "subjectAltName=DNS:pve.mock,IP:127.0.0.1",
		"-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
	], { stdio: "ignore" });
	return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
}

export async function startMockPve(): Promise<MockPve> {
	const { key, cert } = makeCert();
	const requests: Recorded[] = [];
	const guests: MockPve["guests"] = {
		"qemu/100": { status: "stopped" },
		"lxc/105": { status: "running" },
		"lxc/106": { status: "running" },
	};

	const control = { down: false, dropReused: 0, tasksForbidden: false };
	const perSocket = new WeakMap<object, number>();

	const server = https.createServer({ key, cert }, (req, res) => {
		const url = new URL(req.url ?? "/", "https://x");
		const n = (perSocket.get(req.socket) ?? 0) + 1;
		perSocket.set(req.socket, n);
		const record: Recorded = { method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization };
		requests.push(record);

		// Simulate the keep-alive race (server closed the idle connection as we reused it) or a full outage.
		const dropThis = control.down || (n > 1 && control.dropReused > 0);
		if (dropThis) {
			if (!control.down) control.dropReused--;
			record.dropped = true;
			req.socket.destroy();
			return;
		}
		const send = (status: number, data: unknown, message?: string) => {
			res.writeHead(status, message, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data }));
		};

		if (req.headers.authorization !== `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`) return send(401, null, "authentication failure");

		const p = url.pathname;
		if (req.method === "GET" && p === "/api2/json/cluster/resources") {
			return send(200, [
				{ id: "node/pve", type: "node", node: "pve", status: "online", cpu: 0.231, maxcpu: 8, mem: 12 * 2 ** 30, maxmem: 32 * 2 ** 30, disk: 20 * 2 ** 30, maxdisk: 94 * 2 ** 30, uptime: 3 * 86400 + 4 * 3600 },
				{ id: "qemu/100", type: "qemu", node: "pve", vmid: 100, name: "homeassistant", status: guests["qemu/100"]!.status, cpu: 0, maxcpu: 2, mem: 0, maxmem: 4 * 2 ** 30, uptime: 0 },
				{ id: "lxc/106", type: "lxc", node: "pve", vmid: 106, name: "audiobookshelf", status: guests["lxc/106"]!.status, cpu: 0.042, maxcpu: 2, mem: 410 * 2 ** 20, maxmem: 2 * 2 ** 30, uptime: 86400 * 2 },
				{ id: "lxc/105", type: "lxc", node: "pve", vmid: 105, name: "jellyfin", status: guests["lxc/105"]!.status, cpu: 0.78, maxcpu: 4, mem: 3.7 * 2 ** 30, maxmem: 4 * 2 ** 30, uptime: 3600 * 5 },
				{ id: "lxc/900", type: "lxc", node: "pve", vmid: 900, name: "debian-template", status: "stopped", template: 1 },
				{ id: "storage/pve/local", type: "storage", node: "pve", storage: "local", status: "available", plugintype: "dir", content: "iso,vztmpl,backup", shared: 0, disk: 18 * 2 ** 30, maxdisk: 94 * 2 ** 30 },
				{ id: "storage/pve/local-lvm", type: "storage", node: "pve", storage: "local-lvm", status: "available", plugintype: "lvmthin", content: "images,rootdir", shared: 0, disk: 150 * 2 ** 30, maxdisk: 180 * 2 ** 30 },
				{ id: "storage/pve/nas-backups", type: "storage", node: "pve", storage: "nas-backups", status: "unknown", plugintype: "cifs", content: "backup", shared: 1 },
				{ id: "storage/pve2/local", type: "storage", node: "pve2", storage: "local", status: "available", plugintype: "dir", disk: 1, maxdisk: 2 },
			]);
		}
		if (req.method === "GET" && p === "/api2/json/nodes/pve/status") {
			return send(200, { cpu: 0.25, wait: 0.031, loadavg: ["0.42", "0.39", "0.30"], memory: { used: 12.5 * 2 ** 30, total: 31.2 * 2 ** 30 }, swap: { used: 1 * 2 ** 30, total: 8 * 2 ** 30 }, rootfs: { used: 18 * 2 ** 30, total: 94 * 2 ** 30 }, uptime: 3 * 86400 + 4 * 3600, cpuinfo: { cpus: 8, model: "Mock CPU" } });
		}
		if (req.method === "GET" && p === "/api2/json/nodes/pve/rrddata") {
			return send(200, [{ time: 1, netin: 1000, netout: 2000 }, { time: 2, netin: 125000, netout: 62500 }, { time: 3 }]);
		}
		if (req.method === "GET" && p === "/api2/json/nodes/pve/tasks") {
			if (control.tasksForbidden) return send(403, null, "Permission check failed");
			const now = Math.floor(Date.now() / 1000);
			const h = 3600;
			return send(200, [
				{ upid: "UPID:pve:1:vzdump:105", type: "vzdump", id: "105", node: "pve", user: "root@pam", starttime: now - 120, status: "RUNNING" },
				{ upid: "UPID:pve:2:vncproxy:106", type: "vncproxy", id: "106", node: "pve", user: "root@pam", starttime: now - 300, endtime: now - 200, status: "OK" },
				{ upid: "UPID:pve:3:vzdump:106", type: "vzdump", id: "106", node: "pve", user: "root@pam", starttime: now - 6 * h, endtime: now - 6 * h + 252, status: "OK" },
				{ upid: "UPID:pve:4:vzdump:100", type: "vzdump", id: "100", node: "pve", user: "root@pam", starttime: now - 6 * h - 600, endtime: now - 6 * h - 570, status: "job errors" },
				{ upid: "UPID:pve:5:aptupdate", type: "aptupdate", id: "", node: "pve", user: "root@pam", starttime: now - 8 * h, endtime: now - 8 * h + 20, status: "WARNINGS: 1" },
				{ upid: "UPID:pve:6:qmstart:100", type: "qmstart", id: "100", node: "pve", user: "root@pam", starttime: now - 30 * h, endtime: now - 30 * h + 3, status: "OK" },
			]);
		}
		const power = p.match(/^\/api2\/json\/nodes\/pve\/(lxc|qemu)\/(\d+)\/status\/(start|shutdown|stop)$/);
		if (req.method === "POST" && power) {
			const k = `${power[1]}/${power[2]}`;
			if (!guests[k]) return send(500, null, `${k} does not exist`);
			guests[k]!.status = power[3] === "start" ? "running" : "stopped";
			return send(200, `UPID:pve:0001:${power[3]}:${k}:`);
		}
		send(501, null, "not implemented");
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `https://127.0.0.1:${port}`,
		port,
		fingerprint: new X509Certificate(cert).fingerprint256,
		requests,
		guests,
		control,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
