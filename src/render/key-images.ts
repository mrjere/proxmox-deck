/**
 * SVG images for keys. Stream Deck accepts SVG directly (Elgato recommends it),
 * so we draw every key as a string of SVG; it stays sharp at any key size.
 * Canvas is 144x144 (the high-DPI key size); Stream Deck scales it down.
 */
import { COLOURS, formatPct, levelColour, statusColour, truncate, wrap, xml } from "../proxmox/format.js";

const SIZE = 144;
const FONT = "Arial, Helvetica, sans-serif";

function svg(body: string, background: string = COLOURS.bg): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${background}"/>${body}</svg>`;
}

function text(x: number, y: number, value: string, size: number, fill: string, opts: { anchor?: "start" | "middle" | "end"; weight?: number } = {}): string {
	return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${fill}" text-anchor="${opts.anchor ?? "start"}">${xml(value)}</text>`;
}

/** Turns an SVG string into the data URL format `setImage` accepts. */
export function toDataUrl(markup: string): string {
	return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

/** Area sparkline along the bottom of the key. */
function sparkline(values: readonly number[], colour: string, fixedMax?: number): string {
	if (values.length < 2) return "";
	const top = 98;
	const bottom = 136;
	const left = 8;
	const right = SIZE - 8;
	const max = fixedMax ?? Math.max(...values, 1e-9);
	const step = (right - left) / (values.length - 1);
	const points = values.map((v, i) => `${(left + i * step).toFixed(1)},${(bottom - (Math.min(v, max) / max) * (bottom - top)).toFixed(1)}`);
	return (
		`<polygon points="${left},${bottom} ${points.join(" ")} ${right},${bottom}" fill="${colour}" fill-opacity="0.18"/>` +
		`<polyline points="${points.join(" ")}" fill="none" stroke="${colour}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
	);
}

export type StatKeyModel = {
	label: string; // "pve · CPU"
	value: string; // "23%"
	colour: string; // value + sparkline colour
	history: readonly number[];
	historyMax?: number; // 100 for percentages; undefined = auto-scale
	detail?: string; // small line under the value
};

/** Node metric key: label, big value, sparkline. */
export function statKey(m: StatKeyModel): string {
	return svg(
		text(SIZE / 2, 28, truncate(m.label, 16), 18, COLOURS.muted, { anchor: "middle" }) +
			text(SIZE / 2, m.detail ? 68 : 76, m.value, m.value.length > 7 ? 26 : 38, m.colour, { anchor: "middle", weight: 700 }) +
			(m.detail ? text(SIZE / 2, 90, truncate(m.detail, 18), 15, COLOURS.muted, { anchor: "middle" }) : "") +
			sparkline(m.history, m.colour, m.historyMax),
	);
}

/** Shown when something's wrong (or not set up yet). */
export function messageKey(title: string, message: string, colour: string = COLOURS.bad): string {
	const lines = wrap(message, 14, 4);
	return svg(
		text(SIZE / 2, 30, truncate(title, 14), 19, COLOURS.text, { anchor: "middle", weight: 700 }) +
			lines.map((line, i) => text(SIZE / 2, 62 + i * 21, line, 17, colour, { anchor: "middle" })).join(""),
	);
}

function barRow(y: number, label: string, value: number | undefined): string {
	const x = 52;
	const width = 56;
	const filled = Math.max(0, Math.min(100, value ?? 0)) / 100;
	return (
		text(10, y + 11, label, 15, COLOURS.muted) +
		`<rect x="${x}" y="${y}" width="${width}" height="12" rx="6" fill="${COLOURS.track}"/>` +
		(filled > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(12, width * filled).toFixed(1)}" height="12" rx="6" fill="${levelColour(value)}"/>` : "") +
		text(SIZE - 8, y + 11, formatPct(value), 15, COLOURS.text, { anchor: "end" })
	);
}

export type GuestKeyModel = {
	name: string;
	kind: string; // "LXC 106"
	status: string;
	cpuPct?: number;
	memPct?: number;
};

/** Container/VM key: status dot, name, CPU and RAM bars. */
export function guestKey(m: GuestKeyModel): string {
	const running = m.status === "running";
	const header =
		`<circle cx="16" cy="22" r="7" fill="${statusColour(m.status)}"/>` +
		// ~114px of room after the dot: big text for short names, smaller for long ones.
		(m.name.length <= 8
			? text(30, 29, m.name, 20, COLOURS.text, { weight: 700 })
			: text(30, 28, truncate(m.name, 11), 16, COLOURS.text, { weight: 700 })) +
		text(10, 54, m.kind, 15, COLOURS.muted);
	const body = running
		? barRow(78, "CPU", m.cpuPct) + barRow(106, "RAM", m.memPct)
		: text(SIZE / 2, 104, m.status, 22, statusColour(m.status), { anchor: "middle", weight: 700 });
	return svg(header + body);
}
