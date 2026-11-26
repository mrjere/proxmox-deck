/** Small, pure formatting helpers shared by keys and dials. */

export const COLOURS = {
	ok: "#3fb950",
	warn: "#d29922",
	bad: "#f85149",
	info: "#58a6ff",
	muted: "#8b949e",
	text: "#e6edf3",
	track: "#2b3038",
	bg: "#0d1117",
} as const;

/**
 * Colour for a percentage. Thresholds are deliberately high (70% / 90%) so the
 * key only changes colour when it's worth a look; constant amber teaches you to
 * ignore it ("alert fatigue").
 */
export function levelColour(pct: number | undefined, warnAt = 70, badAt = 90): string {
	if (pct === undefined || !Number.isFinite(pct)) return COLOURS.muted;
	if (pct >= badAt) return COLOURS.bad;
	if (pct >= warnAt) return COLOURS.warn;
	return COLOURS.ok;
}

export function statusColour(status: string | undefined): string {
	if (status === "running" || status === "online") return COLOURS.ok;
	if (status === "stopped" || status === "offline") return COLOURS.muted;
	return COLOURS.warn; // paused, suspended, unknown...
}

export function pct(used: number | undefined, total: number | undefined): number | undefined {
	if (used === undefined || !total) return undefined;
	return Math.max(0, Math.min(100, (used / total) * 100));
}

export function formatPct(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "–";
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number | undefined, decimals = 1): string {
	if (bytes === undefined || !Number.isFinite(bytes)) return "–";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : decimals)} ${UNITS[unit]}`;
}

/** "12.5 / 31.2 GiB": both numbers in the larger value's unit, so the unit appears once. */
export function formatBytesPair(used: number | undefined, total: number | undefined, decimals = 1): string {
	if (used === undefined || total === undefined || !Number.isFinite(used) || !Number.isFinite(total)) return "–";
	let unit = 0;
	let divisor = 1;
	while (total / divisor >= 1024 && unit < UNITS.length - 1) {
		divisor *= 1024;
		unit++;
	}
	const d = unit === 0 ? 0 : decimals;
	return `${(used / divisor).toFixed(d)} / ${(total / divisor).toFixed(d)} ${UNITS[unit]}`;
}

/** Network rates read better in bits (that's how your ISP and switch talk). */
export function formatRate(bytesPerSecond: number | undefined): string {
	if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return "–";
	const bits = bytesPerSecond * 8;
	if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
	if (bits >= 1e3) return `${Math.round(bits / 1e3)} kb/s`;
	return `${Math.round(bits)} b/s`;
}

export function formatUptime(seconds: number | undefined): string {
	if (!seconds || !Number.isFinite(seconds)) return "–";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Escapes text for safe use inside SVG/XML (guest names can contain & or <). */
export function xml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Naive word wrap by character count; good enough for short error messages. */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		const candidate = line ? `${line} ${word}` : word;
		if (candidate.length <= maxChars) {
			line = candidate;
		} else {
			if (line) lines.push(line);
			line = word.length > maxChars ? truncate(word, maxChars) : word;
		}
		if (lines.length === maxLines) break;
	}
	if (line && lines.length < maxLines) lines.push(line);
	if (lines.length === maxLines && lines.join(" ").length < text.length) {
		lines[maxLines - 1] = truncate(lines[maxLines - 1]!, maxChars);
	}
	return lines;
}

/** "4m 12s", "1h 3m", "42s". */
export function formatDuration(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "–";
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Friendly local time for a unix timestamp: "Today 03:00", "Yesterday 22:10", "Tue 14:05", "3 Nov". */
export function formatWhen(unixSeconds: number, now: Date = new Date()): string {
	const d = new Date(unixSeconds * 1000);
	const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
	if (days === 0) return `Today ${hhmm}`;
	if (days === 1) return `Yesterday ${hhmm}`;
	if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${hhmm}`;
	return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
