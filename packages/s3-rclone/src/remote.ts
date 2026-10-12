import type { FileStat, FolderStat, Fs, ListReporter, Stat } from '@hesprs/sync-engine-sdk';
import { isFolder } from '@repo/shared/path';
import type { SaveFile } from './wrapper';
import { nonEmptyFolders, omitEmptyFolders } from './directories';
import { metadataTime, timeValue } from './times';
import MetadataFs from './wrapper';

export default class RcloneFs extends MetadataFs {
	constructor(
		original: Fs,
		private readonly options: {
			enabled: () => boolean;
			preferMetadataMtime: () => boolean;
			getMeta: (key: string) => Promise<Dict<string>>;
		},
	) {
		super(original);
	}

	private downloadMeta(stat: FileStat, getMeta = stat.meta): FileStat['meta'] {
		return async () => {
			const meta = await getMeta();
			if (!this.options.enabled()) return meta;
			const preferred = this.options.preferMetadataMtime()
				? metadataTime(meta.mtime, 'seconds')
				: undefined;
			const mtime = preferred ?? timeValue(stat.mtime);
			const result = { ...meta };
			if (mtime === undefined) delete result.mtime;
			else result.mtime = String(mtime);
			return result;
		};
	}

	protected decorate(stat: Stat): Stat {
		return stat.isDir ? stat : { ...stat, meta: this.downloadMeta(stat) };
	}

	protected async save(stat: FileStat, action: SaveFile) {
		if (!this.options.enabled()) return action(stat);
		const meta = { ...(await stat.meta()) };
		const mtime = metadataTime(meta.mtime, 'milliseconds');
		if (mtime === undefined) delete meta.mtime;
		else meta.mtime = String(mtime / 1000);
		return action({ ...stat, meta: () => meta });
	}

	read(key: string, stat: FileStat) {
		if (this.options.enabled())
			stat.meta = this.downloadMeta(stat, () => this.options.getMeta(key));
		return this.original.read(key, stat);
	}

	readStream(key: string, stat: FileStat) {
		if (this.options.enabled())
			stat.meta = this.downloadMeta(stat, () => this.options.getMeta(key));
		return this.original.readStream(key, stat);
	}

	mkdir(key: string, stat: FolderStat, recursive?: boolean) {
		if (!this.options.enabled()) return this.original.mkdir(key, stat, recursive);
	}

	move(oldKey: string, newKey: string) {
		if (this.options.enabled() && isFolder(oldKey)) return;
		return this.original.move(oldKey, newKey);
	}

	async list(key: string, reporter: ListReporter) {
		if (!this.options.enabled()) return this.original.list(key, reporter);
		const stopped = new Map<string, boolean>();
		const blocked = (path: string) => {
			for (const [folder, excluded] of stopped)
				if (path.startsWith(folder) && (excluded || path !== folder)) return true;
			return false;
		};
		const report: ListReporter = async (progress) => {
			const current = progress.current;
			const decision = await reporter(progress);
			if (isFolder(current) && decision !== 'advance')
				stopped.set(current, decision === 'exclude');
			return decision;
		};
		const stats = await this.original.list(key, report);
		const entries = new Map(stats.map((stat) => [stat.key, stat]));
		const folders = [...nonEmptyFolders(stats)].filter(
			(folder) =>
				folder !== key && (key === '/' || folder.startsWith(key)) && !entries.has(folder),
		);
		let completed = stats.length;
		for (const folder of folders.sort()) {
			if (blocked(folder)) continue;
			const decision = await report({
				completed: ++completed,
				current: folder,
				total: stats.length + folders.length,
			});
			if (decision !== 'exclude')
				entries.set(folder, { isDir: true, key: folder, meta: () => ({}) });
		}
		return omitEmptyFolders([...entries.values()].filter((stat) => !blocked(stat.key))).map(
			(stat) => this.decorate(stat),
		);
	}
}
