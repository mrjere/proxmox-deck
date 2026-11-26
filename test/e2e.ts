/**
 * End-to-end test: a fake Stream Deck app.
 *
 * Launches the real built plugin (bin/plugin.js) exactly the way Stream Deck
 * does (WebSocket + registration arguments), puts all four actions "on screen",
 * presses keys / turns dials, and checks what the plugin sends back. The
 * plugin talks to the mock Proxmox server over HTTPS with a pinned certificate.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import { startMockPve, TOKEN_ID, TOKEN_SECRET } from "./mock-pve.js";

type Msg = { event: string; context?: string; id?: string; payload?: any };

const UUID = "com.jere.proxmox-deck";
const DEVICE = "dev-plus";
const pve = await startMockPve();

let globalSettings: Record<string, unknown> = { host: pve.url, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, fingerprint: pve.fingerprint };
const actionSettings = new Map<string, Record<string, unknown>>();
const received: Msg[] = [];
let socket: WebSocket | undefined;

const instances = [
	{ context: "ctx-stat", action: `${UUID}.node-stat`, controller: "Keypad", coordinates: { column: 0, row: 0 }, settings: { metric: "cpu" } },
	{ context: "ctx-guest", action: `${UUID}.guest`, controller: "Keypad", coordinates: { column: 1, row: 0 }, settings: { guest: "lxc/106" } },
	{ context: "ctx-ndial", action: `${UUID}.node-dial`, controller: "Encoder", coordinates: { column: 0, row: 0 }, settings: {} },
	{ context: "ctx-gdial", action: `${UUID}.guest-dial`, controller: "Encoder", coordinates: { column: 1, row: 0 }, settings: {} },
	{ context: "ctx-sdial", action: `${UUID}.storage-dial`, controller: "Encoder", coordinates: { column: 2, row: 0 }, settings: {} },
	{ context: "ctx-tdial", action: `${UUID}.tasks-dial`, controller: "Encoder", coordinates: { column: 3, row: 0 }, settings: { filter: "backups" } },
];
for (const i of instances) actionSettings.set(i.context, { ...i.settings });
const byContext = (ctx: string) => instances.find((i) => i.context === ctx)!;

function send(msg: object) {
	socket!.send(JSON.stringify(msg));
}
function actionEvent(event: string, context: string, extra: object = {}) {
	const i = byContext(context);
	send({ event, action: i.action, context, device: DEVICE, payload: { controller: i.controller, coordinates: i.coordinates, isInMultiAction: false, resources: {}, settings: actionSettings.get(context), ...extra } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, find: () => T | undefined, timeoutMs = 8000): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const found = find();
		if (found) return found;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for: ${what}`);
}
const decodeImage = (m: Msg) => decodeURIComponent(String(m.payload?.image ?? "").replace(/^data:image\/svg\+xml,/, ""));
const after = (index: number) => received.slice(index);
const mark = () => received.length;

// ---- Fake Stream Deck WebSocket server ----
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>((r) => wss.once("listening", () => r()));
const port = (wss.address() as AddressInfo).port;

const registered = new Promise<void>((resolve) => {
	wss.on("connection", (ws) => {
		socket = ws;
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data)) as Msg;
			received.push(msg);
			switch (msg.event) {
				case "registerPlugin":
					resolve();
					break;
				case "getGlobalSettings":
					send({ event: "didReceiveGlobalSettings", id: msg.id, payload: { settings: globalSettings } });
					break;
				case "getSettings": {
					const i = byContext(msg.context!);
					send({ event: "didReceiveSettings", id: msg.id, action: i.action, context: i.context, device: DEVICE, payload: { controller: i.controller, coordinates: i.coordinates, isInMultiAction: false, resources: {}, settings: actionSettings.get(i.context) } });
					break;
				}
				case "setSettings":
					actionSettings.set(msg.context!, msg.payload);
					break;
			}
		});
	});
});

const info = {
	application: { font: "Arial", language: "en", platform: "windows", platformVersion: "10", version: "7.1.0.0" },
	colors: {},
	devicePixelRatio: 1,
	devices: [{ id: DEVICE, name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
	plugin: { uuid: UUID, version: "0.1.0.0" },
};
const plugin: ChildProcess = spawn(process.execPath, ["bin/plugin.js", "-port", String(port), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
	cwd: "com.jere.proxmox-deck.sdPlugin",
	stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
plugin.stderr!.on("data", (d) => (stderr += d));

const results: { name: string; ok: boolean; error?: unknown }[] = [];
async function step(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, error });
	}
}

try {
	await Promise.race([registered, sleep(8000).then(() => { throw new Error(`plugin never registered\n${stderr}`); })]);
	results.push({ name: "plugin starts and registers with Stream Deck", ok: true });

	for (const i of instances) actionEvent("willAppear", i.context);

	await step("host stat key draws live CPU from Proxmox", async () => {
		const img = await waitFor("stat image with CPU", () => received.find((m) => m.event === "setImage" && m.context === "ctx-stat" && decodeImage(m).includes("pve · CPU")));
		assert.match(decodeImage(img), /25%/);
	});

	await step("guest key draws name, status and bars", async () => {
		const img = await waitFor("guest image", () => received.find((m) => m.event === "setImage" && m.context === "ctx-guest" && decodeImage(m).includes("audiobooks")));
		assert.match(decodeImage(img), /LXC 106/);
		assert.match(decodeImage(img), /CPU/);
	});

	await step("host dial shows CPU on the touch strip", async () => {
		const fb = await waitFor("node dial feedback", () => received.find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.name === "pve · CPU"));
		assert.equal(fb.payload.pos, "1/9");
		assert.equal(fb.payload.value.value, "25%");
		assert.equal(fb.payload.detail.value, "8 cores · load 0.42");
	});

	await step("guest dial shows first guest (VM 100, stopped)", async () => {
		const fb = await waitFor("guest dial feedback", () => received.find((m) => m.event === "setFeedback" && m.context === "ctx-gdial" && m.payload?.name === "homeassistant"));
		assert.equal(fb.payload.pos, "1/3");
		assert.match(fb.payload.sub.value, /VM 100 · stopped/);
	});

	await step("changing a key's metric in its settings page redraws it (RAM)", async () => {
		const m0 = mark();
		actionSettings.set("ctx-stat", { metric: "mem" });
		// What Stream Deck sends the plugin after the settings page saves (no `id`).
		const i = byContext("ctx-stat");
		send({ event: "didReceiveSettings", action: i.action, context: i.context, device: DEVICE, payload: { controller: i.controller, coordinates: i.coordinates, isInMultiAction: false, resources: {}, settings: { metric: "mem" } } });
		const img = await waitFor("RAM image", () => after(m0).find((m) => m.event === "setImage" && m.context === "ctx-stat" && decodeImage(m).includes("pve · RAM")));
		assert.match(decodeImage(img), /12\.5 \/ 31\.2 GiB/);
		// ...and keeps using RAM on the next poll rather than reverting to CPU.
		const m1 = mark();
		await waitFor("next poll image", () => after(m1).find((m) => m.event === "setImage" && m.context === "ctx-stat"), 8000);
		assert.ok(!after(m1).some((m) => m.event === "setImage" && m.context === "ctx-stat" && decodeImage(m).includes("pve · CPU")));
	});

	await step("turning the host dial switches to RAM and remembers it", async () => {
		const m0 = mark();
		actionEvent("dialRotate", "ctx-ndial", { ticks: 1, pressed: false });
		await waitFor("setSettings mem", () => after(m0).find((m) => m.event === "setSettings" && m.context === "ctx-ndial" && m.payload?.metric === "mem"));
		const fb = await waitFor("RAM feedback", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.name === "pve · RAM"));
		assert.equal(fb.payload.detail.value, "12.5 / 31.2 GiB");
	});

	await step("turning the host dial left wraps around to uptime", async () => {
		const m0 = mark();
		actionEvent("dialRotate", "ctx-ndial", { ticks: -2, pressed: false });
		await waitFor("uptime feedback", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.name === "pve · Uptime"));
	});

	await step("turning the guest dial steps to the next guest", async () => {
		const m0 = mark();
		actionEvent("dialRotate", "ctx-gdial", { ticks: 1, pressed: false });
		await waitFor("setSettings guest", () => after(m0).find((m) => m.event === "setSettings" && m.context === "ctx-gdial" && m.payload?.guest === "lxc/105"));
		await waitFor("jellyfin feedback", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-gdial" && m.payload?.name === "jellyfin"));
	});

	await step("pushing the guest dial opens that guest in the web UI", async () => {
		const m0 = mark();
		actionEvent("dialDown", "ctx-gdial");
		await sleep(80);
		actionEvent("dialUp", "ctx-gdial");
		const open = await waitFor("openUrl", () => after(m0).find((m) => m.event === "openUrl"));
		assert.equal(open.payload.url, `${pve.url}/#v1:0:=lxc%2F105`);
	});

	await step("pressing the guest key opens it in the web UI", async () => {
		const m0 = mark();
		actionEvent("keyDown", "ctx-guest");
		await sleep(80);
		actionEvent("keyUp", "ctx-guest");
		const open = await waitFor("openUrl", () => after(m0).find((m) => m.event === "openUrl"));
		assert.equal(open.payload.url, `${pve.url}/#v1:0:=lxc%2F106`);
	});

	await step("holding a key refreshes (tick shown) and does NOT open the browser", async () => {
		const m0 = mark();
		const polls = pve.requests.filter((r) => r.path === "/api2/json/cluster/resources").length;
		actionEvent("keyDown", "ctx-stat");
		await waitFor("showOk while still held", () => after(m0).find((m) => m.event === "showOk" && m.context === "ctx-stat"), 3000);
		actionEvent("keyUp", "ctx-stat");
		await sleep(200);
		assert.ok(!after(m0).some((m) => m.event === "openUrl"), "no browser on hold");
		assert.ok(pve.requests.filter((r) => r.path === "/api2/json/cluster/resources").length > polls, "actually polled");
	});

	await step("short press on a dial opens the web UI", async () => {
		const m0 = mark();
		actionEvent("dialDown", "ctx-ndial");
		await sleep(80);
		actionEvent("dialUp", "ctx-ndial");
		const open = await waitFor("openUrl", () => after(m0).find((m) => m.event === "openUrl"));
		assert.equal(open.payload.url, `${pve.url}/#v1:0:=node%2Fpve`);
	});

	await step("holding a dial refreshes with 'Refreshing…' then '✓ Refreshed', no browser", async () => {
		const m0 = mark();
		actionEvent("dialDown", "ctx-ndial");
		await waitFor("Refreshing…", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.detail?.value === "Refreshing…"), 3000);
		await waitFor("✓ Refreshed", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.detail?.value === "✓ Refreshed"), 5000);
		actionEvent("dialUp", "ctx-ndial");
		await sleep(200);
		assert.ok(!after(m0).some((m) => m.event === "openUrl"), "no browser on hold");
		// The message clears itself and normal detail returns.
		await waitFor("detail restored", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.detail?.value && !String(m.payload.detail.value).includes("Refresh")), 4000);
	});

	await step("tapping the strip refreshes with feedback on the guest dial's status line", async () => {
		const m0 = mark();
		actionEvent("touchTap", "ctx-gdial", { hold: false, tapPos: [100, 50] });
		await waitFor("✓ Refreshed", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-gdial" && m.payload?.sub?.value === "✓ Refreshed"), 5000);
	});

	await step("storage dial shows local storage, turns to local-lvm (amber at 83%)", async () => {
		const fb = await waitFor("storage feedback", () => received.find((m) => m.event === "setFeedback" && m.context === "ctx-sdial" && m.payload?.name === "local"));
		assert.equal(fb.payload.pos, "1/3");
		assert.equal(fb.payload.detail.value, "18.0 / 94.0 GiB · dir");
		const m0 = mark();
		actionEvent("dialRotate", "ctx-sdial", { ticks: 1, pressed: false });
		const lvm = await waitFor("lvm feedback", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-sdial" && m.payload?.name === "local-lvm"));
		assert.equal(lvm.payload.value.value, "83%");
		assert.equal(lvm.payload.value.color, "#d29922");
		const m1 = mark();
		actionEvent("dialRotate", "ctx-sdial", { ticks: 1, pressed: false });
		const nas = await waitFor("nas feedback", () => after(m1).find((m) => m.event === "setFeedback" && m.context === "ctx-sdial" && m.payload?.name === "nas-backups · shared"));
		assert.equal(nas.payload.value.value, "Offline");
	});

	await step("tasks dial (backups) shows the running backup, then the failed one", async () => {
		const fb = await waitFor("tasks feedback", () => received.find((m) => m.event === "setFeedback" && m.context === "ctx-tdial" && m.payload?.name === "jellyfin"));
		assert.equal(fb.payload.value.value, "Running…");
		assert.equal(fb.payload.pos, "1/3");
		assert.equal(fb.payload.summary.value, "24h: 1 ok · 1 failed · 1 running");
		const m0 = mark();
		actionEvent("dialRotate", "ctx-tdial", { ticks: 2, pressed: false });
		const failed = await waitFor("failed backup", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-tdial" && m.payload?.name === "homeassistant"));
		assert.equal(failed.payload.value.value, "Failed");
		assert.match(failed.payload.detail.value, /job errors/);
	});

	await step("tasks dial set to 'problems' in its settings shows failures and warnings only", async () => {
		const m0 = mark();
		const i = byContext("ctx-tdial");
		actionSettings.set("ctx-tdial", { filter: "problems" });
		send({ event: "didReceiveSettings", action: i.action, context: i.context, device: DEVICE, payload: { controller: i.controller, coordinates: i.coordinates, isInMultiAction: false, resources: {}, settings: { filter: "problems" } } });
		const fb = await waitFor("problems", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-tdial" && m.payload?.pos === "1/2"));
		assert.equal(fb.payload.name, "Backup · homeassistant");
	});

	await step("settings page: guest list and connection test", async () => {
		send({ event: "propertyInspectorDidAppear", action: `${UUID}.guest`, context: "ctx-guest", device: DEVICE });
		await sleep(50);
		let m0 = mark();
		send({ event: "sendToPlugin", action: `${UUID}.guest`, context: "ctx-guest", payload: { event: "lists" } });
		const lists = await waitFor("lists", () => after(m0).find((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "lists"));
		assert.equal(lists.payload.ok, true);
		assert.deepEqual(lists.payload.nodes, ["pve"]);
		assert.deepEqual(lists.payload.guests.map((g: any) => g.value), ["qemu/100", "lxc/105", "lxc/106"]);
		assert.equal(lists.payload.guests[2].label, "106 · audiobookshelf (LXC)");
		m0 = mark();
		send({ event: "sendToPlugin", action: `${UUID}.guest`, context: "ctx-guest", payload: { event: "test" } });
		const test = await waitFor("test result", () => after(m0).find((m) => m.event === "sendToPropertyInspector" && m.payload?.event === "test"));
		assert.deepEqual({ ok: test.payload.ok, message: test.payload.message }, { ok: true, message: "Connected: 1 node, 4 guests" });
	});

	await step("changing settings to a wrong fingerprint: keys show the problem, token not sent", async () => {
		const before = pve.requests.length;
		const wrong = pve.fingerprint.replace(/^../, pve.fingerprint.startsWith("00") ? "11" : "00");
		globalSettings = { ...globalSettings, fingerprint: wrong };
		const m0 = mark();
		// No `id` = a change made in the settings page (not a reply to a request).
		send({ event: "didReceiveGlobalSettings", payload: { settings: globalSettings } });
		const img = await waitFor("error image", () => after(m0).find((m) => m.event === "setImage" && m.context === "ctx-stat" && decodeImage(m).includes("fingerprint")));
		assert.match(decodeImage(img), /Certificate/);
		const fb = await waitFor("dial error", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && m.payload?.value?.value === "Offline"));
		assert.match(fb.payload.detail.value, /fingerprint/);
		assert.equal(pve.requests.length, before, "no HTTP request (so no token) reached the server");
	});

	await step("tapping the strip while offline retries and shows an alert", async () => {
		const m0 = mark();
		actionEvent("touchTap", "ctx-ndial", { hold: false, tapPos: [100, 50] });
		await waitFor("showAlert", () => after(m0).find((m) => m.event === "showAlert" && m.context === "ctx-ndial"));
		await waitFor("✗ message", () => after(m0).find((m) => m.event === "setFeedback" && m.context === "ctx-ndial" && String(m.payload?.detail?.value ?? "").startsWith("✗")));
	});

	await step("fixing the fingerprint recovers without restarting", async () => {
		globalSettings = { ...globalSettings, fingerprint: pve.fingerprint };
		const m0 = mark();
		send({ event: "didReceiveGlobalSettings", payload: { settings: globalSettings } });
		await waitFor("recovered", () => after(m0).find((m) => m.event === "setImage" && m.context === "ctx-stat" && decodeImage(m).includes("pve · RAM")));
	});

	await step("hiding every action stops polling", async () => {
		for (const i of instances) send({ event: "willDisappear", action: i.action, context: i.context, device: DEVICE, payload: { controller: i.controller, coordinates: i.coordinates, isInMultiAction: false, resources: {}, settings: actionSettings.get(i.context) } });
		await sleep(300);
		const before = pve.requests.length;
		await sleep(6500); // longer than the 5s poll interval
		assert.equal(pve.requests.length, before);
	});

	await step("view-only: no request other than GET was ever sent", async () => {
		assert.deepEqual([...new Set(pve.requests.map((r) => r.method))], ["GET"]);
	});

	await step("API token never appears in plugin output", async () => {
		assert.ok(!stderr.includes(TOKEN_SECRET));
	});
} finally {
	plugin.kill();
	wss.close();
	await pve.close();
}

let failed = 0;
for (const r of results) {
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
	if (!r.ok) {
		failed++;
		console.log(`      ${r.error instanceof Error ? r.error.message : String(r.error)}`);
	}
}
if (failed && stderr) console.log("\nplugin stderr:\n" + stderr.slice(-3000));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
