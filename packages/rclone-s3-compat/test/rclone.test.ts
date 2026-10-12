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

function adapter(original: Fs, needDirFix = true) {
	return new RcloneFs(original, needDirFix);
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

test('stat leaves folders unchanged', async () => {
	const fs = adapter(testFs({ control: { stat: () => folder('dir/') } }).fs);
	expect(await fs.stat('dir/')).toEqual(folder('dir/'));
});

test('list infers parent folders and converts timestamps', async () => {
	const backend = listing([
		file('vault/notes/nested/note.md', { meta: () => ({ mtime: SECONDS }) }),
	]);
	const fs = adapter(backend.fs);
	const stats = await fs.list('vault/notes/', () => 'advance');
	expect(stats.map((s) => s.key)).toEqual(['vault/notes/nested/note.md', 'vault/notes/nested/']);
	expect(await stats[0].meta()).toEqual({ mtime: String(MS) });
});

test('list skips the listed folder itself', async () => {
	const backend = listing([file('vault/notes/note.md', { meta: () => ({ mtime: SECONDS }) })]);
	const fs = adapter(backend.fs);
	const stats = await fs.list('vault/notes/', () => 'advance');
	expect(stats.map((s) => s.key)).toEqual(['vault/notes/note.md']);
});

test('list does not duplicate existing folder entries', async () => {
	const backend = listing([
		folder('notes/nested/'),
		file('notes/nested/note.md', { meta: () => ({ mtime: SECONDS }) }),
	]);
	const fs = adapter(backend.fs);
	const stats = await fs.list('/', () => 'advance');
	expect(stats.filter((s) => s.key === 'notes/nested/')).toHaveLength(1);
});

test('mkdir is a no-op', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs);
	await fs.mkdir('empty/nested/', folder('empty/nested/'), true);
	await fs.mkdir('/', folder('/'), true);
	expect(backend.calls.mkdir).toEqual([]);
});

test('move skips folder keys but forwards file moves', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs);
	await fs.move('old/', 'new/');
	await fs.move('old/note.md', 'new/note.md');
	expect(backend.calls.move).toEqual([['old/note.md', 'new/note.md']]);
});

test('with needDirFix=false, mkdir forwards and list skips inference', async () => {
	const backend = testFs({
		control: {
			list: () => [file('notes/note.md', { meta: () => ({ mtime: SECONDS }) })],
		},
	});
	const fs = adapter(backend.fs, false);
	await fs.mkdir('notes/', folder('notes/'));
	expect(backend.calls.mkdir).toHaveLength(1);
	const stats = await fs.list('/', () => 'advance');
	expect(stats.map((s) => s.key)).toEqual(['notes/note.md']);
});

test('with needDirFix=false, move forwards folder keys', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs, false);
	await fs.move('old/', 'new/');
	expect(backend.calls.move).toEqual([['old/', 'new/']]);
});

test('module registers wrapper only for s3 and cleans up', () => {
	const wrappers: Array<FsWrapperEntry> = [];
	const settings = { asymmetricStorage: false, remoteFs: 's3' };
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
