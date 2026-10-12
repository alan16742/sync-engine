export function timeValue(value: number): number | undefined {
	if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return;
	return Math.trunc(value);
}

export function metadataTime(
	value: string | undefined,
	unit: 'seconds' | 'milliseconds',
): number | undefined {
	const text = value?.trim();
	if (!text) return;
	if (/^-?\d+(?:\.\d+)?$/u.test(text)) {
		if (unit === 'milliseconds') return timeValue(Number(text));
		const [seconds, fraction = ''] = text.split('.');
		const sign = text.startsWith('-') ? -1 : 1;
		return timeValue(
			Number(seconds) * 1000 + sign * Number(fraction.slice(0, 3).padEnd(3, '0')),
		);
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) return;
	const time = timeValue(Date.parse(text));
	if (time === undefined) return;
	const zone = text.slice(-6);
	const offset = text.endsWith('Z')
		? 0
		: (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone.startsWith('-') ? -1 : 1);
	if (new Date(time + offset * 60_000).toISOString().slice(0, 19) === text.slice(0, 19))
		return time;
}
