import type {
	Binary,
	FileStat,
	FolderStat,
	Fs,
	ListReporter,
	Stat,
	WrappedFs,
} from '@hesprs/sync-engine-sdk';
import { msToSeconds, secondsToMs } from '@/times';

/**
 * Adapts S3Fs for `rclone serve s3`:
 * - Converts `x-amz-meta-mtime` between Sync Engine milliseconds and rclone seconds.
 * Timestamp conversion passes through non-numeric values (e.g. encrypted meta) unchanged.
 */
export default class RcloneFs implements WrappedFs {
	constructor(readonly original: Fs) {}

	getUid() {
		return this.original.getUid();
	}

	read(key: string, stat: FileStat) {
		return this.original.read(key, stat);
	}

	readStream(key: string, stat: FileStat) {
		return this.original.readStream(key, stat);
	}

	async write(key: string, value: Binary, stat: FileStat) {
		return this.original.write(key, value, await convertWriteStat(stat));
	}

	async writeStream(key: string, value: ReadableStream<Binary>, stat: FileStat) {
		return this.original.writeStream(key, value, await convertWriteStat(stat));
	}

	delete(key: string) {
		return this.original.delete(key);
	}

	mkdir(key: string, stat: FolderStat, recursive?: boolean) {
		return this.original.mkdir(key, stat, recursive);
	}

	move(oldKey: string, newKey: string) {
		return this.original.move(oldKey, newKey);
	}

	async stat(key: string) {
		return decorate(await this.original.stat(key));
	}

	exists(key: string) {
		return this.original.exists(key);
	}

	async list(key: string, reporter: ListReporter) {
		const stats = await this.original.list(key, reporter);
		return stats.map((stat) => decorate(stat, true));
	}
}

async function convertWriteStat(stat: FileStat): Promise<FileStat> {
	const meta = { ...(await stat.meta()) };
	const seconds = msToSeconds(meta.mtime ?? String(stat.mtime));
	if (seconds !== undefined) meta.mtime = seconds;
	return { ...stat, meta: () => meta };
}

function decorate(stat: Stat, fromList = false): Stat {
	if (stat.isDir) return stat;
	const originalMeta = stat.meta;
	return {
		...stat,
		meta: async () => {
			const meta = { ...(await originalMeta()) };
			const ms = secondsToMs(meta.mtime);
			// LIST retains milliseconds even when GET/HEAD metadata is missing or rounded.
			if (fromList && (meta.mtime === undefined || ms !== undefined))
				meta.mtime = String(stat.mtime);
			else if (ms !== undefined) meta.mtime = ms;
			return meta;
		},
	};
}
