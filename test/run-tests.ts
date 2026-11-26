/**
 * Tests for the Proxmox core (no Stream Deck needed). Run with `npm test`.
 */
import assert from "node:assert/strict";
import net from "node:net";

import { ProxmoxClient } from "../src/proxmox/client.js";
import { formatBytesPair, formatDuration, formatRate, formatUptime, formatWhen, wrap, xml } from "../src/proxmox/format.js";
import { HOLD_MS, PressTracker } from "../src/actions/press.js";
import { describeMetric } from "../src/render/metrics.js";
import { normaliseFingerprint } from "../src/proxmox/http.js";
import { ProxmoxService, type Snapshot, taskState } from "../src/proxmox/service.js";
import { normaliseBaseUrl, type GlobalSettings, toConnectionConfig } from "../src/settings.js";
import { startMockPve, TOKEN_ID, TOKEN_SECRET } from "./mock-pve.js";

const results: { name: string; ok: boolean; error?: unknown }[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, error });
	}
}

const pve = await startMockPve();
const base: GlobalSettings = { host: pve.url, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET };
const clientFor = (s: GlobalSettings) => {
	const cfg = toConnectionConfig(s);
	assert.equal(typeof cfg, "object", `config invalid: ${String(cfg)}`);
	return new ProxmoxClient(cfg as Exclude<typeof cfg, string>);
};

await test("settings: host normalisation", () => {
	assert.equal(normaliseBaseUrl("192.168.1.10"), "https://192.168.1.10:8006");
	assert.equal(normaliseBaseUrl("pve.lan/"), "https://pve.lan:8006");
	assert.equal(normaliseBaseUrl("https://pve.lan:8443"), "https://pve.lan:8443");
	assert.equal(normaliseBaseUrl("http://pve.lan"), "https://pve.lan:8006");
	assert.equal(toConnectionConfig({}), "Add your Proxmox host");
	assert.equal(toConnectionConfig({ host: "x", tokenId: "nobang", tokenSecret: "s" }), "Token ID should look like user@pve!name");
});

await test("fingerprint normalisation accepts Proxmox's format", () => {
	const fp = pve.fingerprint; // "AB:CD:..."
	assert.ok(normaliseFingerprint(fp));
	assert.equal(normaliseFingerprint(fp.toLowerCase()), normaliseFingerprint(fp));
	assert.equal(normaliseFingerprint(fp.replace(/:/g, " ")), normaliseFingerprint(fp));
	assert.equal(normaliseFingerprint("AB:CD"), undefined);
});

await test("pinned fingerprint: connects and reads resources", async () => {
	const c = clientFor({ ...base, fingerprint: pve.fingerprint });
	const r = await c.resources();
	assert.ok(r.some((x) => x.id === "lxc/106"));
	c.dispose();
});

await test("wrong fingerprint: refused BEFORE the token is sent", async () => {
	const before = pve.requests.length;
	const wrong = pve.fingerprint.replace(/^../, pve.fingerprint.startsWith("00") ? "11" : "00");
	const c = clientFor({ ...base, fingerprint: wrong });
	await assert.rejects(c.resources(), /fingerprint doesn't match/);
	assert.equal(pve.requests.length, before, "server must not have received any HTTP request (so no token)");
	c.dispose();
});

await test("no fingerprint + self-signed: refused with a helpful message", async () => {
	const c = clientFor(base);
	await assert.rejects(c.resources(), /Untrusted certificate/);
	c.dispose();
});

await test("insecure mode: connects (but not recommended)", async () => {
	const c = clientFor({ ...base, insecure: true });
	assert.ok((await c.resources()).length > 0);
	c.dispose();
});

await test("bad token secret: clear 401 message", async () => {
	const c = clientFor({ ...base, tokenSecret: "nope", fingerprint: pve.fingerprint });
	await assert.rejects(c.resources(), /Token rejected/);
	c.dispose();
});

await test("connection refused: friendly message", async () => {
	const srv = net.createServer();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as net.AddressInfo).port;
	await new Promise<void>((r) => srv.close(() => r())); // free port, nothing listening
	const c = clientFor({ ...base, host: `127.0.0.1:${port}`, insecure: true });
	await assert.rejects(c.resources(), /Connection refused/);
	c.dispose();
});

await test("keep-alive race: a GET on a dropped reused connection is retried once and succeeds", async () => {
	const c = clientFor({ ...base, fingerprint: pve.fingerprint });
	await c.resources(); // opens a connection that stays in the pool
	const before = pve.requests.length;
	pve.control.dropReused = 1;
	const r = await c.resources(); // reuses it -> server drops it -> retried on a fresh one
	assert.ok(r.length > 0);
	const tried = pve.requests.slice(before);
	assert.equal(tried.length, 2, "one dropped attempt + one retry");
	assert.equal(tried[0]!.dropped, true);
	assert.ok(!tried[1]!.dropped);
	c.dispose();
});

await test("hysteresis: one failed poll keeps last good data; two in a row show offline; recovery is logged", async () => {
	const svc = new ProxmoxService();
	const logs: string[] = [];
	svc.log = (level, message) => logs.push(`${level}: ${message}`);
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const good = await svc.refresh();
	assert.ok(good.ok);
	pve.control.down = true;
	try {
		const first = await svc.refresh();
		assert.equal(first, good, "first failure: still showing the last good snapshot");
		const second = await svc.refresh();
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.error, "Connection reset");
	} finally {
		pve.control.down = false;
	}
	const back = await svc.refresh();
	assert.ok(back.ok);
	assert.deepEqual(logs, [
		"warn: Poll failed (1 in a row): Connection reset",
		"warn: Poll failed (2 in a row): Connection reset",
		"info: Connection restored after 2 failed polls",
	]);
	assert.ok(!logs.join(" ").includes(TOKEN_SECRET), "token never logged");
});

await test("config errors still show immediately (no hysteresis before first good poll)", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base }); // no fingerprint -> untrusted
	const s = await svc.refresh();
	assert.equal(s.ok, false);
});

await test("service: snapshot has node, guests (templates hidden), net rates, history", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const snaps: Snapshot[] = [];
	const unsubscribe = svc.subscribe((s) => snaps.push(s));
	const s = await svc.refresh();
	await svc.refresh();
	unsubscribe();
	assert.ok(s.ok, !s.ok ? s.error : "");
	if (!s.ok) return;
	assert.equal(s.node?.name, "pve");
	assert.equal(Math.round(s.node!.cpuPct!), 25);
	assert.equal(s.node?.cores, 8);
	assert.equal(s.node?.load1, 0.42);
	assert.equal(s.node?.netIn, 125000); // skipped the empty newest RRD point
	assert.deepEqual(s.guests.map((g) => g.key), ["qemu/100", "lxc/105", "lxc/106"]);
	assert.equal(Math.round(s.guests[1]!.memPct!), 93);
	assert.ok(svc.history("node:cpu").length >= 2);
	assert.ok(snaps.length >= 2);
});

await test("service: concurrent refreshes share one poll", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const before = pve.requests.filter((r) => r.path === "/api2/json/cluster/resources").length;
	await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
	const after = pve.requests.filter((r) => r.path === "/api2/json/cluster/resources").length;
	assert.equal(after - before, 1);
});

await test("service: missing settings -> not-configured snapshot, no crash", async () => {
	const svc = new ProxmoxService();
	svc.configure({});
	const s = await svc.refresh();
	assert.equal(s.ok, false);
	if (!s.ok) {
		assert.equal(s.configured, false);
		assert.equal(s.error, "Add your Proxmox host");
	}
});

await test("service: unknown node name is reported", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint, node: "pve2" });
	const s = await svc.refresh();
	assert.equal(s.ok, false);
	if (!s.ok) assert.match(s.error, /Node "pve2" not found/);
});

await test("test(): reports counts on success and reason on failure", async () => {
	const good = await ProxmoxService.test({ ...base, fingerprint: pve.fingerprint });
	assert.deepEqual(good, { ok: true, message: "Connected: 1 node, 4 guests" });
	const bad = await ProxmoxService.test({ ...base });
	assert.equal(bad.ok, false);
	assert.match(bad.message, /Untrusted certificate/);
});

await test("view-only: the client has no methods that change anything", () => {
	const methods = Object.getOwnPropertyNames(ProxmoxClient.prototype).filter((m) => m !== "constructor").sort();
	assert.deepEqual(methods, ["dispose", "get", "nodeRrd", "nodeStatus", "resources", "tasks"]);
});

await test("node info includes IO delay and swap", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const s = await svc.refresh();
	assert.ok(s.ok);
	if (!s.ok) return;
	assert.equal(s.node!.iowaitPct!.toFixed(1), "3.1");
	assert.equal(s.node!.swapPct, 12.5);
	const io = describeMetric(s.node!, "iowait");
	assert.equal(io.value, "3.1%");
	assert.equal(describeMetric(s.node!, "swap").detail, "1.0 / 8.0 GiB");
	assert.equal(describeMetric({ ...s.node!, maxswap: 0 }, "swap").value, "None");
});

await test("storage: this node's storage only, sorted, with usage and shared flag", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const s = await svc.refresh();
	assert.ok(s.ok);
	if (!s.ok) return;
	assert.deepEqual(s.storages.map((x) => x.name), ["local", "local-lvm", "nas-backups"]);
	const lvm = s.storages[1]!;
	assert.equal(Math.round(lvm.usedPct!), 83);
	assert.equal(lvm.type, "lvmthin");
	assert.equal(s.storages[2]!.shared, true);
	assert.equal(s.storages[2]!.status, "unknown");
});

await test("tasks: only fetched while wanted, throttled, forced refresh re-fetches", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const taskCalls = () => pve.requests.filter((r) => r.path.startsWith("/api2/json/nodes/pve/tasks")).length;
	const start = taskCalls();
	const off = svc.subscribe(() => {});
	await svc.refresh();
	assert.equal(taskCalls(), start, "nobody wants tasks -> not fetched");
	const s0 = await svc.refresh();
	assert.equal(s0.ok && s0.tasks, undefined);
	const offTasks = svc.subscribe(() => {}, ["tasks"]);
	await svc.refresh();
	assert.equal(taskCalls(), start + 1, "fetched once wanted");
	await svc.refresh();
	await svc.refresh();
	assert.equal(taskCalls(), start + 1, "throttled to every 30s");
	await svc.refresh({ force: true });
	assert.equal(taskCalls(), start + 2, "manual refresh fetches now");
	offTasks();
	off();
});

await test("tasks: labels use guest names, noise filtered, newest first, states mapped", async () => {
	const svc = new ProxmoxService();
	svc.configure({ ...base, fingerprint: pve.fingerprint });
	const off = svc.subscribe(() => {}, ["tasks"]);
	const s = await svc.refresh({ force: true });
	off();
	assert.ok(s.ok);
	if (!s.ok) return;
	const t = s.tasks!;
	assert.ok(!t.some((x) => x.type === "vncproxy"), "console sessions hidden");
	assert.deepEqual(t.map((x) => x.label), ["Backup · jellyfin", "Backup · audiobookshelf", "Backup · homeassistant", "Update check", "VM start · homeassistant"]);
	assert.deepEqual(t.map((x) => x.state), ["running", "ok", "failed", "warn", "ok"]);
	assert.equal(taskState({ status: "OK" }), "ok");
	assert.equal(taskState({ status: undefined, endtime: undefined }), "running");
});

await test("tasks: a permission error doesn't break the rest of the snapshot", async () => {
	pve.control.tasksForbidden = true;
	try {
		const svc = new ProxmoxService();
		svc.configure({ ...base, fingerprint: pve.fingerprint });
		const off = svc.subscribe(() => {}, ["tasks"]);
		const s = await svc.refresh({ force: true });
		off();
		assert.ok(s.ok, "snapshot still ok");
		if (!s.ok) return;
		assert.equal(s.tasksError, "Token lacks permission");
		assert.deepEqual(s.tasks, []);
		assert.ok(s.node);
	} finally {
		pve.control.tasksForbidden = false;
	}
});

await test("press vs hold: short press, hold fires while held, stray up ignored", async () => {
	const p = new PressTracker();
	let holds = 0;
	p.down("a", () => holds++);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(p.up("a"), "press");
	assert.equal(holds, 0);
	p.down("a", () => holds++);
	await new Promise((r) => setTimeout(r, HOLD_MS + 80));
	assert.equal(holds, 1, "hold acts before release");
	assert.equal(p.up("a"), "hold");
	assert.equal(p.up("b"), "none");
});

await test("time helpers", () => {
	const now = new Date(2026, 10, 26, 16, 0, 0);
	const at = (d: Date) => Math.floor(d.getTime() / 1000);
	assert.equal(formatWhen(at(new Date(2026, 10, 26, 3, 0)), now), "Today 03:00");
	assert.equal(formatWhen(at(new Date(2026, 10, 25, 22, 10)), now), "Yesterday 22:10");
	assert.equal(formatWhen(at(new Date(2026, 10, 24, 14, 5)), now), "Tue 14:05");
	assert.equal(formatWhen(at(new Date(2026, 10, 3, 9, 0)), now), "3 Nov");
	assert.equal(formatDuration(252), "4m 12s");
	assert.equal(formatDuration(42), "42s");
	assert.equal(formatDuration(3780), "1h 3m");
});

await test("format helpers", () => {
	assert.equal(formatRate(125000), "1.0 Mb/s");
	assert.equal(formatBytesPair(12.5 * 2 ** 30, 31.2 * 2 ** 30), "12.5 / 31.2 GiB");
	assert.equal(formatBytesPair(18 * 2 ** 30, 94 * 2 ** 30, 0), "18 / 94 GiB");
	assert.equal(formatUptime(3 * 86400 + 4 * 3600), "3d 4h");
	assert.equal(xml(`a<b & "c"`), "a&lt;b &amp; &quot;c&quot;");
	assert.deepEqual(wrap("Connection refused. Check host and port", 14, 3), ["Connection", "refused. Check", "host and port"]);
});

await test("no request other than GET ever reached the server", () => {
	assert.deepEqual([...new Set(pve.requests.map((r) => r.method))], ["GET"]);
});

await pve.close();

let failed = 0;
for (const r of results) {
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
	if (!r.ok) {
		failed++;
		console.log(`      ${r.error instanceof Error ? r.error.stack : String(r.error)}`);
	}
}
console.log(`\n${results.length - failed}/${results.length} passed`);
// Give pooled keep-alive sockets no chance to hold the process open.
process.exit(failed ? 1 : 0);
