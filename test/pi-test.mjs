// Runs ui/pi.js inside jsdom against a fake Stream Deck WebSocket and checks
// the settings page loads, saves, fills drop-downs and shows test results.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { WebSocketServer } from "ws";

const dir = "com.jere.proxmox-deck.sdPlugin/ui/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
	throw new Error("Timed out: " + what);
}

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
const port = wss.address().port;
const got = [];
let sock;
wss.on("connection", (ws) => {
	sock = ws;
	ws.on("message", (d) => {
		const m = JSON.parse(String(d)); got.push(m);
		if (m.event === "getGlobalSettings") ws.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { host: "192.168.1.10", tokenId: "streamdeck@pve!deck", tokenSecret: "s3cret", pollSeconds: 10 } } }));
	});
});
const out = (m) => sock.send(JSON.stringify(m));

const results = [];
async function step(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, e]); } }

// Load the guest key's page with the real pi.js inlined (jsdom won't fetch local files by default).
let html = readFileSync(dir + "guest.html", "utf8").replace('<script src="pi.js"></script>', () => `<script>${readFileSync(dir + "pi.js", "utf8")}</script>`);
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
const { window } = dom;
const doc = window.document;
// jsdom's WebSocket is fine; point it at our fake server.
// The page's UUID and the key's context differ on purpose: messages must use the page's UUID.
const actionInfo = { action: "com.jere.proxmox-deck.guest", context: "ctx-guest", device: "d", payload: { settings: { guest: "lxc/106" }, controller: "Keypad", coordinates: { column: 0, row: 0 } } };
window.connectElgatoStreamDeckSocket(String(port), "pi-uuid", "registerPropertyInspector", "{}", JSON.stringify(actionInfo));

await step("connection section is injected once", async () => {
	assert.equal(doc.querySelectorAll("#host").length, 1);
	assert.ok(doc.querySelector("#tokenSecret").type === "password", "secret is a password field");
});
await step("registers, then asks for global settings and the lists", async () => {
	await waitFor("register", () => got.find((m) => m.event === "registerPropertyInspector" && m.uuid === "pi-uuid"));
	await waitFor("getGlobalSettings", () => got.find((m) => m.event === "getGlobalSettings" && m.context === "pi-uuid"));
	const lists = await waitFor("lists request", () => got.find((m) => m.event === "sendToPlugin" && m.payload?.event === "lists"));
	assert.equal(lists.context, "pi-uuid", "sendToPlugin must use the settings page's UUID");
	assert.equal(lists.action, "com.jere.proxmox-deck.guest");
});
await step("fields fill from saved settings", async () => {
	await waitFor("host filled", () => doc.querySelector("#host").value === "192.168.1.10");
	assert.equal(doc.querySelector("#tokenId").value, "streamdeck@pve!deck");
	assert.equal(doc.querySelector("#pollSeconds").value, "10");
	assert.equal(doc.querySelector("#insecure").checked, false);
});
await step("guest drop-down fills and keeps the saved choice", async () => {
	out({ event: "sendToPropertyInspector", payload: { event: "lists", ok: true, nodes: ["pve"], guests: [{ value: "qemu/100", label: "100 · homeassistant (VM)" }, { value: "lxc/106", label: "106 · audiobookshelf (LXC)" }] } });
	const sel = doc.querySelector("#guest");
	await waitFor("options", () => sel.options.length === 3);
	assert.equal(sel.value, "lxc/106");
	assert.ok(![...sel.options].some((o) => o.textContent === "Loading…"), "placeholder replaced");
	const node = doc.querySelector("#node");
	assert.deepEqual([...node.options].map((o) => o.value), ["", "pve"]);
	assert.equal(node.options[0].textContent, "Automatic (first node)");
});
await step("choosing a guest saves this key's settings", async () => {
	const sel = doc.querySelector("#guest");
	sel.value = "qemu/100";
	sel.dispatchEvent(new window.Event("change"));
	const m = await waitFor("setSettings", () => got.find((x) => x.event === "setSettings" && x.payload?.guest === "qemu/100"));
	assert.equal(m.context, "pi-uuid", "setSettings must use the settings page's UUID");
	assert.equal(m.action, "com.jere.proxmox-deck.guest");
});
await step("typing a fingerprint saves global settings once (debounced), keeping other fields", async () => {
	const fp = doc.querySelector("#fingerprint");
	for (const ch of "AB:CD") { fp.value += ch; fp.dispatchEvent(new window.Event("input")); await sleep(30); }
	await sleep(800);
	const saves = got.filter((x) => x.event === "setGlobalSettings");
	assert.equal(saves.length, 1, `expected 1 debounced save, got ${saves.length}`);
	assert.equal(saves[0].context, "pi-uuid");
	assert.deepEqual(saves[0].payload, { host: "192.168.1.10", tokenId: "streamdeck@pve!deck", tokenSecret: "s3cret", pollSeconds: 10, fingerprint: "AB:CD" });
});
await step("insecure checkbox saves a boolean", async () => {
	const cb = doc.querySelector("#insecure");
	cb.checked = true; cb.dispatchEvent(new window.Event("change"));
	await waitFor("save", () => got.filter((x) => x.event === "setGlobalSettings").at(-1)?.payload.insecure === true, 2000);
});
await step("Test connection button asks the plugin and shows the result", async () => {
	doc.querySelector("#test").click();
	assert.equal(doc.querySelector("#status").textContent, "Testing…");
	const req = await waitFor("test request", () => got.find((x) => x.event === "sendToPlugin" && x.payload?.event === "test"), 2000);
	assert.equal(req.context, "pi-uuid");
	out({ event: "sendToPropertyInspector", payload: { event: "test", ok: false, message: "Untrusted certificate. Add its fingerprint" } });
	await waitFor("status", () => doc.querySelector("#status").textContent.startsWith("Untrusted"));
	assert.match(doc.querySelector("#status").className, /error/);
});
await step("plugin-side settings change (dial turned) updates the page", async () => {
	out({ event: "didReceiveSettings", action: actionInfo.action, context: "ctx-guest", payload: { settings: { guest: "lxc/106" } } });
	await waitFor("updated", () => doc.querySelector("#guest").value === "lxc/106");
});

wss.close(); window.close();
let failed = 0;
for (const [n, ok, e] of results) { console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { failed++; console.log("      " + (e?.message ?? e)); } }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
