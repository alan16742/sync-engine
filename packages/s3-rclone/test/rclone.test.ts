import type { FileStat, Fs, FsWrapperEntry, Stat, Translate } from '@hesprs/sync-engine-sdk';
import { testKit } from '@hesprs/sync-engine-sdk/dev';
import { expect, test } from 'bun:test';
import type { MetadataTranslations } from '../src/setting';
import S3Rclone from '../src';
import rcloneLocalWrapper from '../src/local';
import RcloneFs from '../src/remote';

const { bytes, file, folder, fs: testFs, stream } = testKit;
const LOCAL_MTIME = 1_700_000_123_456;
const REMOTE_MTIME = 1_710_000_000_000;
const CTIME = '1600000123456';

function adapter(original: Fs, options: { prefer?: boolean; enabled?: boolean } = {}) {
	return new RcloneFs(original, {
		enabled: () => options.enabled ?? true,
		getMeta: async (key) => (await original.stat(key)).meta(),
		preferMetadataMtime: () => options.prefer ?? false,
	});
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
	'%s sends rclone seconds and preserves creation time and source metadata',
	async (method) => {
		const meta = { ctime: CTIME, custom: 'value', mtime: String(LOCAL_MTIME) };
		const source = file('note.md', { meta: () => meta, mtime: LOCAL_MTIME });
		const backend = testFs({
			control: {
				write: async (_key, _value, stat) => {
					expect(await stat.meta()).toEqual({ ...meta, mtime: '1700000123.456' });
					return 'written';
				},
				writeStream: async (_key, _value, stat) => {
					expect(await stat.meta()).toEqual({ ...meta, mtime: '1700000123.456' });
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
		expect(source.mtime).toBe(LOCAL_MTIME);
	},
);

test.each([
	['1700000123.456', true, LOCAL_MTIME],
	['1700000123.456999', true, LOCAL_MTIME],
	['2023-11-14T22:15:23.456Z', true, LOCAL_MTIME],
	['2023-11-15T06:15:23.456+08:00', true, LOCAL_MTIME],
	['1700000123.456', false, REMOTE_MTIME],
	[undefined, true, REMOTE_MTIME],
	['', true, REMOTE_MTIME],
	['invalid', true, REMOTE_MTIME],
	['Infinity', true, REMOTE_MTIME],
	['1e9', true, REMOTE_MTIME],
	['8640000000001', true, REMOTE_MTIME],
	['2024-02-30T00:00:00Z', true, REMOTE_MTIME],
	['0', true, 0],
	['-0.001', true, -1],
] as const)(
	'download metadata %s with preference %s restores %s milliseconds',
	async (mtime, prefer, expected) => {
		const source = file('note.md', {
			meta: () => ({ ctime: CTIME, mtime }),
			mtime: REMOTE_MTIME,
			uid: 'remote-uid',
		});
		const fs = adapter(testFs({ control: { stat: () => source } }).fs, { prefer });
		const stat = await fileStat(fs, source.key);
		expect(await stat.meta()).toEqual({ ctime: CTIME, mtime: String(expected) });
		expect(stat.mtime).toBe(REMOTE_MTIME);
		expect(stat.uid).toBe('remote-uid');
	},
);

test.each(['read', 'readStream'] as const)(
	'%s replaces cached local metadata with remote metadata without converting twice',
	async (method) => {
		const backend = testFs({
			control: {
				stat: () =>
					file('note.md', {
						meta: () => ({ ctime: CTIME, mtime: '1700000123.456' }),
						mtime: REMOTE_MTIME,
					}),
			},
		});
		const fs = adapter(backend.fs, { prefer: true });
		const cached = file('note.md', { meta: () => ({ mtime: String(LOCAL_MTIME) }) });
		await fs[method](cached.key, cached);
		expect(await cached.meta()).toEqual({ ctime: CTIME, mtime: String(LOCAL_MTIME) });
		await fs[method](cached.key, cached);
		expect(await cached.meta()).toEqual({ ctime: CTIME, mtime: String(LOCAL_MTIME) });
	},
);

test.each(['local', 'remote'] as const)(
	'%s listing omits empty directory trees and keeps parents of zero-byte files',
	async (side) => {
		const backend = listing([
			folder('empty/'),
			folder('empty/nested/'),
			folder('notes/'),
			folder('notes/empty/'),
			folder('notes/nested/'),
			file('notes/nested/zero.md', { size: 0 }),
		]);
		const fs =
			side === 'local' ? rcloneLocalWrapper(backend.fs, () => true) : adapter(backend.fs);
		const stats = await fs.list('/', () => 'advance');
		expect(stats.map((stat) => stat.key)).toEqual([
			'notes/',
			'notes/nested/',
			'notes/nested/zero.md',
		]);
	},
);

test('remote listing synthesizes nonempty parents inside the requested prefix', async () => {
	const backend = listing([file('vault/notes/nested/note.md')]);
	const fs = adapter(backend.fs);
	const reported: Array<string> = [];
	const stats = await fs.list('vault/notes/', ({ current }) => {
		reported.push(current);
		return 'advance';
	});
	const expected = ['vault/notes/nested/note.md', 'vault/notes/nested/'];
	expect(stats.map((stat) => stat.key)).toEqual(expected);
	expect(reported).toEqual(expected);
});

test('remote listing respects excluded synthetic parents and prunes their empty ancestors', async () => {
	const backend = listing([file('notes/private/note.md'), file('public/note.md')]);
	const fs = adapter(backend.fs);
	const stats = await fs.list('/', ({ current }) =>
		current === 'notes/private/' ? 'exclude' : 'advance',
	);
	expect(stats.map((stat) => stat.key)).toEqual(['public/note.md', 'public/']);
});

test('remote mkdir skips directory marker uploads including recursive creation', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs);
	await fs.mkdir('empty/nested/', folder('empty/nested/'), true);
	await fs.mkdir('/', folder('/'), true);
	const source = file('notes/note.md');
	await fs.write(source.key, bytes('note'), source);
	const stats = await adapter(listing([source]).fs).list('/', () => 'advance');
	const local = testFs();
	for (const stat of stats) if (stat.isDir) await local.fs.mkdir(stat.key, stat);
	expect(backend.calls.mkdir).toEqual([]);
	expect(local.calls.mkdir.map(([key]) => key)).toEqual(['notes/']);
	expect(backend.calls.write).toHaveLength(1);
});

test('remote folder moves skip absent markers while child file moves are forwarded', async () => {
	const backend = testFs();
	const fs = adapter(backend.fs);
	await fs.move('old/', 'new/');
	await fs.move('old/note.md', 'new/note.md');
	expect(backend.calls.move).toEqual([['old/note.md', 'new/note.md']]);
});

test('disabled wrappers pass through timestamps and empty folders', async () => {
	const meta = { ctime: CTIME, mtime: String(LOCAL_MTIME) };
	const source = file('note.md', { meta: () => meta });
	const backend = listing([folder('empty/')]);
	backend.control.stat = () => source;
	const fs = adapter(backend.fs, { enabled: false });
	await fs.write(source.key, bytes('note'), source);
	await fs.read(source.key, source);
	await fs.mkdir('empty/', folder('empty/'));
	await fs.move('old/', 'new/');
	const stat = await fileStat(fs, source.key);
	const local = rcloneLocalWrapper(backend.fs, () => false);
	const remoteList = await fs.list('/', () => 'advance');
	const localList = await local.list('/', () => 'advance');
	const written = backend.calls.write[0]?.[2];
	expect(await written?.meta()).toEqual(meta);
	expect(await stat.meta()).toEqual(meta);
	expect(await source.meta()).toEqual(meta);
	expect(remoteList.map((item) => item.key)).toEqual(['empty/']);
	expect(localList.map((item) => item.key)).toEqual(['empty/']);
	expect(backend.calls.mkdir).toHaveLength(1);
	expect(backend.calls.move).toEqual([['old/', 'new/']]);
});

test('module registers both wrappers with metadata preference disabled and cleans them up', () => {
	const remote: Array<FsWrapperEntry> = [];
	const local: Array<FsWrapperEntry> = [];
	const settings = { modules: { encryption: { enabled: false } }, remoteFs: 's3' };
	const module = new S3Rclone({
		registerI18n: () => {},
		registerLocalFsWrapper: (entry) => {
			local.push(entry);
			return () => {
				local.splice(local.indexOf(entry), 1);
			};
		},
		registerRemoteFsWrapper: (entry) => {
			remote.push(entry);
			return () => {
				remote.splice(remote.indexOf(entry), 1);
			};
		},
		registerSetting: () => () => {},
		saveSettings: () => Promise.resolve(),
		settings,
		translate: ((key: string) => key) as Translate<MetadataTranslations>,
	});
	module.start();
	const backend = testFs({ uid: 's3~test' }).fs;
	Object.assign(backend, { getMeta: () => Promise.resolve({}) });
	expect(module.moduleSettings.preferMetadataMtime).toBe(false);
	expect(remote[0]?.apply(backend)).toBeInstanceOf(RcloneFs);
	const localFs = testFs().fs;
	expect(local[0]?.apply(localFs)).toBe(localFs);
	settings.remoteFs = 'webdav';
	expect(remote[0]?.apply(backend)).toBeUndefined();
	expect(local[0]?.apply(testFs().fs)).toBeUndefined();
	module.dispose();
	expect(remote).toEqual([]);
	expect(local).toEqual([]);
});
