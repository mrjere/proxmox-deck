/**
 * Plugin-wide ("global") settings: how to reach your Proxmox host.
 *
 * Why global settings? Elgato stores these on your PC only, and they are NOT
 * included when you export or share a Stream Deck profile, unlike per-key
 * settings. That makes them the right place for an API token secret.
 */
export type GlobalSettings = {
	/** e.g. "192.168.1.10", "pve.lan" or "https://pve.lan:8006". */
	host?: string;
	/** API token ID, e.g. "streamdeck@pve!deck". */
	tokenId?: string;
	/** API token secret (the UUID Proxmox shows once when the token is created). */
	tokenSecret?: string;
	/** SHA-256 fingerprint of the Proxmox certificate, e.g. "AB:CD:...". */
	fingerprint?: string;
	/** Skip certificate checks entirely. Not recommended; use the fingerprint instead. */
	insecure?: boolean;
	/** Which node to show. Blank = the first node found. */
	node?: string;
	/** How often to poll, in seconds. */
	pollSeconds?: number;
};

export type ConnectionConfig = {
	baseUrl: string;
	tokenId: string;
	tokenSecret: string;
	fingerprint?: string;
	insecure: boolean;
};

/** Turns whatever the user typed into "https://host:8006". */
export function normaliseBaseUrl(host: string): string {
	let value = host.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
	const url = new URL(value);
	if (!url.port) url.port = "8006";
	url.protocol = "https:"; // the Proxmox API is HTTPS-only
	return url.origin;
}

/** Returns a usable connection config, or a human-readable reason it isn't usable yet. */
export function toConnectionConfig(s: GlobalSettings): ConnectionConfig | string {
	if (!s.host?.trim()) return "Add your Proxmox host";
	if (!s.tokenId?.trim() || !s.tokenSecret?.trim()) return "Add an API token";
	if (!s.tokenId.includes("!")) return "Token ID should look like user@pve!name";
	let baseUrl: string;
	try {
		baseUrl = normaliseBaseUrl(s.host);
	} catch {
		return "Host doesn't look like an address";
	}
	return {
		baseUrl,
		tokenId: s.tokenId.trim(),
		tokenSecret: s.tokenSecret.trim(),
		fingerprint: s.fingerprint?.trim() || undefined,
		insecure: s.insecure === true,
	};
}

export function pollIntervalMs(s: GlobalSettings): number {
	const seconds = Number(s.pollSeconds);
	// Clamp: faster than 2s adds load for no visible benefit; slower than 60s feels broken.
	return Math.min(60, Math.max(2, Number.isFinite(seconds) && seconds > 0 ? seconds : 5)) * 1000;
}
