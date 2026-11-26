import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import type { ConnectionConfig } from "../settings.js";

/** An error with a short message that fits on a key or the touch strip. */
export class ApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		/** Low-level error code (e.g. "ECONNRESET"), when there is one. */
		readonly code?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/** "ab:cd:..." / "ABCD..." / with spaces -> "ABCD..." (64 hex chars), else undefined. */
export function normaliseFingerprint(value?: string): string | undefined {
	const hex = value?.replace(/[^0-9a-f]/gi, "").toUpperCase();
	return hex && hex.length === 64 ? hex : undefined;
}

/**
 * Builds the HTTPS agent (connection pool) used for every request.
 *
 * Proxmox ships with a self-signed certificate, so normal certificate checks
 * fail. There are three ways to handle that, from best to worst:
 *
 * 1. Pin the fingerprint (recommended): accept exactly one certificate, the one
 *    whose SHA-256 fingerprint you copied from the Proxmox UI. Anything else
 *    (including an attacker on your network) is refused.
 * 2. Normal verification: works if you've installed a real certificate
 *    (e.g. Let's Encrypt via ACME in Proxmox).
 * 3. Insecure: accept any certificate. Easy, but anyone who can intercept
 *    your traffic could capture the API token.
 */
export function createAgent(cfg: Pick<ConnectionConfig, "fingerprint" | "insecure">): https.Agent {
	const pin = normaliseFingerprint(cfg.fingerprint);
	if (!pin) {
		return new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: !cfg.insecure });
	}

	const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

	// Replace how the agent opens sockets: do the TLS handshake ourselves, check
	// the fingerprint, and only then give the socket to the HTTP layer. Because
	// the request (and its Authorization header) is only written once we call
	// back with the socket, the token never reaches an unverified server.
	agent.createConnection = ((options: tls.ConnectionOptions, callback: (err: Error | null, socket?: Duplex) => void) => {
		let settled = false;
		const settle = (err: Error | null, socket?: Duplex) => {
			if (settled) return;
			settled = true;
			callback(err, socket);
		};

		const socket = tls.connect({ ...options, rejectUnauthorized: false });
		socket.once("secureConnect", () => {
			const presented = socket.getPeerCertificate().fingerprint256;
			if (normaliseFingerprint(presented) === pin) {
				settle(null, socket);
			} else {
				socket.destroy();
				settle(new ApiError("Certificate fingerprint doesn't match"));
			}
		});
		socket.once("error", (err) => settle(err));
		return undefined; // tells the agent we'll hand the socket over via the callback
	}) as unknown as typeof agent.createConnection;

	return agent;
}

/** Maps low-level Node/TLS errors to something a human can act on. */
function friendly(err: unknown): ApiError {
	if (err instanceof ApiError) return err;
	const code = (err as NodeJS.ErrnoException)?.code ?? "";
	const make = (message: string) => new ApiError(message, undefined, code || undefined);
	switch (code) {
		case "ECONNREFUSED":
			return make("Connection refused. Check host and port");
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return make("Host not found");
		case "EHOSTUNREACH":
		case "ENETUNREACH":
			return make("Host unreachable");
		case "ETIMEDOUT":
			return make("Timed out");
		case "ECONNRESET":
		case "EPIPE":
		case "ECONNABORTED":
			return make("Connection reset");
		case "DEPTH_ZERO_SELF_SIGNED_CERT":
		case "SELF_SIGNED_CERT_IN_CHAIN":
		case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
		case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
			return make("Untrusted certificate. Add its fingerprint");
		case "ERR_TLS_CERT_ALTNAME_INVALID":
			return make("Certificate is for a different host name");
		default:
			return make((err as Error)?.message || "Request failed");
	}
}

/**
 * Errors that mean "the connection dropped", not "the server said no".
 *
 * The usual cause is a keep-alive race: to avoid a new TLS handshake every few
 * seconds we reuse connections, and Proxmox closes idle ones after a short
 * while. If it closes one just as we send the next poll, that request fails
 * even though nothing is wrong. Browsers handle this by quietly retrying.
 */
const TRANSIENT_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

export function isTransient(err: unknown): boolean {
	return err instanceof ApiError && err.code !== undefined && TRANSIENT_CODES.has(err.code);
}

function describeStatus(status: number, statusMessage: string | undefined): string {
	if (status === 401) return "Token rejected. Check ID and secret";
	if (status === 403) return "Token lacks permission";
	if (status === 404) return "Not found on this Proxmox host";
	if (status === 595 || status === 596) return "Proxmox couldn't reach that node";
	// Proxmox puts useful detail in the status message, e.g. "500 CT 106 is locked".
	return `${status} ${statusMessage ?? "Request failed"}`.trim();
}

/**
 * GETs from the Proxmox API and returns the `data` field of the JSON response.
 * Proxmox wraps every response as `{ "data": ... }`.
 *
 * GET-only on purpose: the plugin never changes anything on the server.
 *
 * A request that hits a dropped connection is retried once on a fresh one.
 * That's safe because a GET only reads ("idempotent"): doing it twice has
 * the same effect as doing it once.
 */
export async function request<T>(cfg: ConnectionConfig, agent: https.Agent, path: string, timeoutMs = 8000): Promise<T> {
	try {
		return await attempt<T>(cfg, agent, path, timeoutMs);
	} catch (err) {
		if (isTransient(err)) return attempt<T>(cfg, agent, path, timeoutMs);
		throw err;
	}
}

function attempt<T>(cfg: ConnectionConfig, agent: https.Agent, path: string, timeoutMs: number): Promise<T> {
	const url = new URL(`/api2/json${path}`, cfg.baseUrl);
	const headers = {
		// API tokens are sent as a header; no login session or CSRF token needed.
		Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`,
		Accept: "application/json",
	};

	return new Promise<T>((resolve, reject) => {
		const req = https.request(url, { method: "GET", agent, headers, timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const status = res.statusCode ?? 0;
				if (status >= 400) {
					reject(new ApiError(describeStatus(status, res.statusMessage), status));
					return;
				}
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data: T };
					resolve(body.data);
				} catch {
					reject(new ApiError("Unexpected response. Is this a Proxmox host?"));
				}
			});
			res.on("error", (err) => reject(friendly(err)));
		});
		req.on("timeout", () => req.destroy(new ApiError("Timed out")));
		req.on("error", (err) => reject(friendly(err)));
		req.end();
	});
}
