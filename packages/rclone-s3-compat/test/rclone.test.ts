import type { FileStat, Fs, FsWrapperEntry, Stat } from '@hesprs/sync-engine-sdk';
import S3Rclone from '@';
import { testKit } from '@hesprs/sync-engine-sdk/dev';
import { expect, test } from 'bun:test';
import RcloneFs from '@/remote';

const { bytes, file, folder, fs: testFs, stream } = testKit;
const MS = 1_700_000_123_456;
const SECONDS = '1700000123.456';
const CTIME = '1600000123456';
const ENCRYPTED = 'dGVzdC1lbmNyeXB0ZWQtbXRpbWU=';

function adapter(original: Fs) {
	return new RcloneFs(original);
}

function listing(stats: Array<Stat>, uid = 's3~test') {
	return testFs({
		control: {
			list: async (_key, reporter) => {
				const result: Array<Stat> = [];
				for (const [index, stat] of stats.entries())
					if (
						(await reporter({
							completed: index + 1,
							current: stat.key,
							total: stats.length,
						})) !== 'exclude'
					)
						result.push(stat);
				return result;
			},
		},
		uid,
	});
}

async function fileStat(fs: Fs, key: string): Promise<FileStat> {
	const stat = await fs.stat(key);
	if (stat.isDir) throw new Error('Expected a file stat');
	return stat;
}

test.each(['write', 'writeStream'] as const)(
	'%s converts mtime milliseconds to rclone seconds',
	async (method) => {
		const meta = { ctime: CTIME, custom: 'value', mtime: String(MS) };
		const source = file('note.md', { meta: () => meta, mtime: MS });
		const backend = testFs({
			control: {
				write: async (_key, _value, stat) => {
					expect(await stat.meta()).toEqual({ ...meta, mtime: SECONDS });
					return 'written';
				},
				writeStream: async (_key, _value, stat) => {
					expect(await stat.meta()).toEqual({ ...meta, mtime: SECONDS });
					return 'written';
				},
			},
		});
		const fs = adapter(backend.fs);
		const uid =
			method === 'write'
				? await fs.write(source.key, bytes('note'), source)
				: await fs.writeStream(source.key, stream(['note']), source);
		expect(uid).toBe('written');
		expect(await source.meta()).toEqual(meta);
	},
);

test('write preserves non-numeric mtime (encrypted meta) unchanged', async () => {
	const meta = { mtime: ENCRYPTED };
	const source = file('note.md', { meta: () => meta });
	const backend = testFs({
		control: {
			write: async (_key, _value, stat) => {
				expect(await stat.meta()).toEqual({ mtime: ENCRYPTED });
				return 'written';
			},
		},
	});
	const fs = adapter(backend.fs);
	await fs.write(source.key, bytes('note'), source);
});

test.each(['write', 'writeStream'] as const)(
	'%s falls back to stat mtime, including zero',
	async (method) => {
		for (const mtime of [MS, 0]) {
			const backend = testFs();
			const fs = adapter(backend.fs);
			const stat = file('note.md', { mtime });
			await (method === 'write'
				? fs.write(stat.key, bytes('note'), stat)
				: fs.writeStream(stat.key, stream(['note']), stat));
			const written =
				method === 'write' ? backend.calls.write[0][2] : backend.calls.writeStream[0][1];
			expect(await written.meta()).toEqual({ mtime: String(mtime / 1000) });
			expect(await stat.meta()).toEqual({});
		}
	},
);

test('stat converts mtime seconds back to milliseconds', async () => {
	const source = file('note.md', {
		meta: () => ({ ctime: CTIME, mtime: SECONDS }),
		mtime: 0,
		uid: 'remote-uid',
	});
	const fs = adapter(testFs({ control: { stat: () => source } }).fs);
	const stat = await fileStat(fs, source.key);
	expect(await stat.meta()).toEqual({ ctime: CTIME, mtime: String(MS) });
	expect(stat.mtime).toBe(0);
	expect(stat.uid).toBe('remote-uid');
});

test('stat preserves non-numeric mtime (encrypted meta) unchanged', async () => {
	const source = file('note.md', { meta: () => ({ mtime: ENCRYPTED }) });
	const fs = adapter(testFs({ control: { stat: () => source } }).fs);
	const stat = await fileStat(fs, source.key);
	expect(await stat.meta()).toEqual({ mtime: ENCRYPTED });
});

test('list preserves encrypted mtime instead of replacing it with LIST time', async () => {
	const source = file('note.md', { meta: () => ({ mtime: ENCRYPTED }), mtime: MS });
	const fs = adapter(listing([source]).fs);
	const [stat] = await fs.list('/', () => 'include');
	expect(await stat.meta()).toEqual({ mtime: ENCRYPTED });
});

test('stat leaves folders unchanged', async () => {
	const fs = adapter(testFs({ control: { stat: () => folder('dir/') } }).fs);
	expect(await fs.stat('dir/')).toEqual(folder('dir/'));
});

test('list keeps the millisecond timestamp exposed by S3', async () => {
	const source = file('note.md', { meta: () => ({ mtime: SECONDS }), mtime: MS });
	const fs = adapter(listing([source]).fs);
	const [stat] = await fs.list('/', () => 'include');
	expect(await stat.meta()).toEqual({ mtime: String(MS) });
});

test('mkdir and move pass through unchanged', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs);
	const dir = folder('empty/');
	await fs.mkdir(dir.key, dir, true);
	await fs.move('empty/', 'moved/');
	expect(backend.calls.mkdir).toEqual([[dir.key, dir, true]]);
	expect(backend.calls.move).toEqual([['empty/', 'moved/']]);
});

test('module registers wrapper only for s3 and cleans up', () => {
	const wrappers: Array<FsWrapperEntry> = [];
	const settings = { remoteFs: 's3' };
	const module = new S3Rclone({
		registerRemoteFsWrapper: (entry) => {
			wrappers.push(entry);
			return () => wrappers.splice(wrappers.indexOf(entry), 1);
		},
		settings,
	});
	module.start();
	expect(wrappers).toHaveLength(1);
	const s3Backend = testFs({ uid: 's3~test' }).fs;
	expect(wrappers[0].apply(s3Backend)).toBeInstanceOf(RcloneFs);
	settings.remoteFs = 'webdav';
	expect(wrappers[0].apply(s3Backend)).toBeUndefined();
	settings.remoteFs = 's3';
	const otherBackend = testFs({ uid: 'webdav~test' }).fs;
	expect(wrappers[0].apply(otherBackend)).toBeUndefined();
	module.dispose();
	expect(wrappers).toEqual([]);
});
