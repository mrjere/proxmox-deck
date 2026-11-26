/*
 * Shared settings-page ("property inspector") logic for every action.
 *
 * Talks to Stream Deck directly over its WebSocket API, so there's no UI
 * library to download and nothing loaded from the internet.
 *
 * Markup conventions used by the HTML pages:
 *   data-global="host"      -> saved in plugin-wide settings (shared by all keys)
 *   data-setting="metric"   -> saved for this key/dial only
 *   data-source="guests"    -> <select> filled with live data from the plugin
 */
(() => {
	"use strict";

	let socket;
	let piUuid;
	let actionInfo;
	let globalSettings = {};
	let settings = {};
	let lists = { nodes: [], guests: [] };

	const $ = (selector) => document.querySelector(selector);
	const $$ = (selector) => [...document.querySelectorAll(selector)];

	// ---- Shared "Connection" section, injected into <div id="connection"> ----
	const connectionHtml = `
		<details id="connection-details">
			<summary>Connection (shared by all Proxmox keys)</summary>
			<div class="field"><label for="host">Host</label>
				<input id="host" data-global="host" type="text" placeholder="192.168.1.10" spellcheck="false" autocomplete="off"></div>
			<div class="field"><label for="tokenId">Token ID</label>
				<input id="tokenId" data-global="tokenId" type="text" placeholder="streamdeck@pve!deck" spellcheck="false" autocomplete="off"></div>
			<div class="field"><label for="tokenSecret">Secret</label>
				<input id="tokenSecret" data-global="tokenSecret" type="password" placeholder="xxxxxxxx-xxxx-…" autocomplete="off"></div>
			<div class="field"><label for="fingerprint">Fingerprint</label>
				<input id="fingerprint" data-global="fingerprint" type="text" placeholder="AB:CD:EF:… (SHA-256)" spellcheck="false" autocomplete="off"></div>
			<p class="hint">Proxmox web UI → your node → System → Certificates → pve-ssl.pem → copy the Fingerprint.</p>
			<div class="field"><label for="node">Node</label>
				<select id="node" data-global="node" data-source="nodes"><option value="" data-keep>Automatic (first node)</option></select></div>
			<div class="field"><label for="pollSeconds">Refresh</label>
				<span class="inline"><input id="pollSeconds" data-global="pollSeconds" type="number" min="2" max="60" step="1" data-default="5"> seconds</span></div>
			<div class="field"><label></label>
				<label class="check"><input id="insecure" data-global="insecure" type="checkbox"> Skip certificate check (not recommended)</label></div>
			<div class="field"><label></label>
				<span class="inline"><button id="test" type="button">Test connection</button></span></div>
			<p id="status" class="status" role="status"></p>
			<details class="help">
				<summary>How do I create an API token?</summary>
				<p>On the Proxmox host shell, create a user and role that can only <em>look</em>, never change anything:</p>
				<pre>pveum role add StreamDeck -privs "Sys.Audit VM.Audit Datastore.Audit"
pveum user add streamdeck@pve --comment "Stream Deck"
pveum acl modify / -user streamdeck@pve -role StreamDeck
pveum user token add streamdeck@pve deck --privsep 0</pre>
				<p>Copy the <code>full-tokenid</code> and <code>value</code> it prints into Token ID and Secret. The secret is only shown once.</p>
				<p>Set up with an earlier version? Remove the power permission with:<br><code>pveum role modify StreamDeck -privs "Sys.Audit VM.Audit Datastore.Audit"</code></p>
			</details>
		</details>`;

	const mount = $("#connection");
	if (mount) mount.innerHTML = connectionHtml;

	// ---- Helpers ----
	// Every message from a settings page is identified by the page's own UUID
	// (the `uuid` Stream Deck passes to connectElgatoStreamDeckSocket), plus the
	// action type. That's what Elgato's own sdpi-components library does, and
	// it's how Stream Deck knows which key the message belongs to. (v0.1.0 used
	// the key's context for setSettings/sendToPlugin, which Stream Deck ignored.)
	function send(event, extra = {}) {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ event, context: piUuid, action: actionInfo?.action, ...extra }));
		}
	}
	const toPlugin = (payload) => send("sendToPlugin", { payload });
	const saveGlobal = () => send("setGlobalSettings", { payload: globalSettings });
	const saveSettings = () => send("setSettings", { payload: settings });

	function debounce(fn, ms) {
		let timer;
		return (...args) => {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), ms);
		};
	}

	function setStatus(text, kind = "") {
		const el = $("#status");
		if (!el) return;
		el.textContent = text;
		el.className = `status ${kind}`;
	}

	function writeField(el, value) {
		if (el.type === "checkbox") el.checked = value === true;
		else if (value !== undefined && value !== null && value !== "") el.value = String(value);
		else el.value = el.dataset.default ?? "";
	}

	function readField(el) {
		if (el.type === "checkbox") return el.checked;
		if (el.type === "number") return el.value === "" ? undefined : Number(el.value);
		return el.value.trim();
	}

	function fillFields() {
		$$("[data-global]").forEach((el) => writeField(el, globalSettings[el.dataset.global]));
		$$("[data-setting]").forEach((el) => writeField(el, settings[el.dataset.setting]));
		// Open the connection section until a host has been entered.
		const details = $("#connection-details");
		if (details && !globalSettings.host) details.open = true;
	}

	/** Fill a live <select>, keeping the saved choice even if it's not currently found. */
	function fillSelect(select) {
		const source = select.dataset.source;
		const saved = select.dataset.global ? globalSettings[select.dataset.global] : settings[select.dataset.setting];
		const items = source === "nodes" ? lists.nodes.map((n) => ({ value: n, label: n })) : lists.guests;

		const keepFirst = select.querySelector("option[data-keep]");
		select.replaceChildren();
		if (keepFirst) select.append(keepFirst);
		else select.append(new Option(items.length ? "Choose…" : "No guests found yet", ""));

		for (const item of items) select.append(new Option(item.label, item.value));
		if (saved && !items.some((i) => i.value === saved)) select.append(new Option(`${saved} (not found)`, saved));
		select.value = saved ?? "";
	}

	const requestLists = debounce(() => toPlugin({ event: "lists" }), 300);

	// ---- Wire up inputs ----
	function bind() {
		const onGlobal = debounce((el) => {
			globalSettings = { ...globalSettings, [el.dataset.global]: readField(el) };
			saveGlobal();
			requestLists();
		}, 600);
		const onSetting = (el) => {
			settings = { ...settings, [el.dataset.setting]: readField(el) };
			saveSettings();
		};

		for (const el of $$("[data-global]")) {
			const eventName = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
			el.addEventListener(eventName, () => onGlobal(el));
		}
		for (const el of $$("[data-setting]")) {
			const eventName = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
			el.addEventListener(eventName, () => onSetting(el));
		}

		$("#test")?.addEventListener("click", () => {
			setStatus("Testing…");
			// Give a just-typed value time to save before testing.
			setTimeout(() => toPlugin({ event: "test" }), 700);
		});
	}

	// ---- Messages from Stream Deck / the plugin ----
	function onMessage(message) {
		switch (message.event) {
			case "didReceiveGlobalSettings":
				globalSettings = message.payload?.settings ?? {};
				fillFields();
				$$("select[data-source]").forEach(fillSelect);
				break;
			case "didReceiveSettings":
				settings = message.payload?.settings ?? {};
				fillFields();
				$$("select[data-source]").forEach(fillSelect);
				break;
			case "sendToPropertyInspector": {
				const data = message.payload ?? {};
				if (data.event === "test") setStatus(data.message, data.ok ? "ok" : "error");
				if (data.event === "lists") {
					if (data.ok) {
						lists = { nodes: data.nodes ?? [], guests: data.guests ?? [] };
					} else {
						setStatus(data.error, "error");
					}
					$$("select[data-source]").forEach(fillSelect);
				}
				break;
			}
		}
	}

	// Stream Deck calls this once the page has loaded.
	window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfoJson) => {
		piUuid = uuid;
		actionInfo = JSON.parse(actionInfoJson);
		settings = actionInfo.payload?.settings ?? {};

		socket = new WebSocket(`ws://127.0.0.1:${port}`);
		socket.onopen = () => {
			socket.send(JSON.stringify({ event: registerEvent, uuid }));
			send("getGlobalSettings");
			fillFields();
			requestLists();
		};
		socket.onmessage = (ev) => {
			try {
				onMessage(JSON.parse(ev.data));
			} catch (err) {
				console.error(err);
			}
		};
		bind();
	};
})();
