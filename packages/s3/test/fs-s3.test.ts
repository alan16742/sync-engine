import type {
	Binary,
	InputAtom,
	MaybePromise,
	OptimizerInput,
	RequestParam,
	RequestResponse,
} from '@hesprs/sync-engine-sdk';
import { testKit } from '@hesprs/sync-engine-sdk/dev';
import { expect, mock, test } from 'bun:test';
import type { S3FsOptions } from '@/s3/fs';
import s3BatchDeleteOptimizer from '@/optimizer';
import S3Fs from '@/s3/fs';
import { sigv4Middleware } from '@/s3/sigv4';
import { defaultCredentials, defaultS3Options, memoryDB, response } from './helpers';

const { bytes, deferred, file, folder, stream: createStream } = testKit;

let parsedResponse: unknown = {};

void mock.module('@repo/shared/parse-xml', () => ({
	default: () => parsedResponse,
}));

type Control = (url: string, params: RequestParam) => MaybePromise<Partial<RequestResponse>>;

const defaultOptions = {
	...defaultS3Options,
} as const satisfies Omit<S3FsOptions, 'request'>;

function createS3Fs(options: Partial<S3FsOptions> = {}) {
	let requestHandler: Control = () => response();
	const harness = testKit.request((url, params) => requestHandler(url, params));
	const request = sigv4Middleware(harness.request, defaultCredentials, memoryDB);
	return {
		calls: harness.calls,
		fs: new S3Fs({ ...defaultOptions, ...options, request }),
		setRequest: (handler: Control) => {
			requestHandler = handler;
		},
	};
}

function assertSignedRequest(params: RequestParam, method: string) {
	expect(params.method).toBe(method);
	expect(params.headers).toMatchObject({
		'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
	});
	expect(params.headers?.['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/u);
	expect(params.headers?.authorization).toMatch(
		/^AWS4-HMAC-SHA256 Credential=access-key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=.*?, Signature=[0-9a-f]{64}$/u,
	);
}

function textBody(params: RequestParam): string {
	return new TextDecoder().decode(params.body as Binary);
}

test('read gets encoded object bytes and maps S3 XML errors', async () => {
	const s3 = createS3Fs();
	s3.setRequest((url, params) => {
		assertSignedRequest(params, 'GET');
		expect(url).toBe('https://s3.example.com/vault/Notes/file%20A.md');
		return response({ body: bytes('content') });
	});
	expect(await s3.fs.read('Notes/file A.md')).toStrictEqual(bytes('content'));

	const errorFs = createS3Fs();
	errorFs.setRequest(() =>
		response({
			status: 404,
			text: '<Error><Code>NoSuchKey</Code><Message>missing object</Message></Error>',
		}),
	);
	parsedResponse = { Error: { Code: 'NoSuchKey', Message: 'missing object' } };
	expect(errorFs.fs.read('missing')).rejects.toMatchObject({
		message: 'S3 NoSuchKey: missing object',
		status: 404,
	});
});

test('write sends binary PUT with meta headers and uses ETag or HEAD metadata fallback', async () => {
	const s3 = createS3Fs();
	const destination = file('Notes/file.md', {
		meta: () => ({ ctime: '100', mtime: '200' }),
		size: 5,
	});
	s3.setRequest((url, params) => {
		assertSignedRequest(params, 'PUT');
		expect(url).toBe('https://s3.example.com/vault/Notes/file.md');
		expect(params.headers?.['Content-Type']).toBe('application/octet-stream');
		expect(params.headers?.['x-amz-meta-ctime']).toBe('100');
		expect(params.headers?.['x-amz-meta-mtime']).toBe('200');
		expect(params.body).toStrictEqual(bytes('hello'));
		return response({ headers: { ETag: '"write-etag"' } });
	});
	expect(await s3.fs.write('Notes/file.md', bytes('hello'), destination)).toBe('write-etag');

	const fallback = createS3Fs();
	fallback.setRequest((_url, params) => {
		if (params.method === 'PUT') return response();
		expect(params.method).toBe('HEAD');
		return response({
			headers: {
				'content-length': '5',
				'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
			},
		});
	});
	expect(
		await fallback.fs.write(
			'Notes/file.md',
			bytes('hello'),
			file('Notes/file.md', { size: 5 }),
		),
	).toBe(`${new Date('Mon, 01 Jan 2024 00:00:00 GMT').valueOf()}~5`);
});

test('writeStream buffers below-part-size input into one PUT', async () => {
	const s3 = createS3Fs();
	s3.setRequest((_url, params) => {
		expect(params.method).toBe('PUT');
		expect(params.body).toStrictEqual(bytes('hello world'));
		return response({ headers: { etag: 'buffered-etag' } });
	});
	const source = createStream([bytes('hello '), bytes('world')]);
	const destination = file('Notes/file.md', { size: 11 });
	const uid = await s3.fs.writeStream('Notes/file.md', source, destination);
	expect(uid).toBe('buffered-etag');
	expect(s3.calls).toHaveLength(1);
});

test('writeStream uploads exact multipart parts and completes with ETag', async () => {
	const partSize = 5 * 1024 * 1024;
	const s3 = createS3Fs();
	s3.setRequest((url, params) => {
		const address = new URL(url);
		if (params.method === 'POST' && address.searchParams.has('uploads')) {
			expect(params.headers?.['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
			expect(params.headers?.['x-amz-meta-ctime']).toBe('300');
			parsedResponse = { InitiateMultipartUploadResult: { UploadId: 'upload-1' } };
			return response({
				text: '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>',
			});
		}
		if (params.method === 'PUT') {
			expect(address.searchParams.get('uploadId')).toBe('upload-1');
			expect(params.headers?.['Content-Type']).toBe('application/octet-stream');
			const partNumber = address.searchParams.get('partNumber');
			return response({ headers: { etag: `part-${partNumber}` } });
		}
		expect(params.method).toBe('POST');
		expect(address.searchParams.get('uploadId')).toBe('upload-1');
		expect(params.headers?.['Content-Type']).toBe('application/xml');
		expect(textBody(params)).toContain('<PartNumber>1</PartNumber><ETag>part-1</ETag>');
		expect(textBody(params)).toContain('<PartNumber>2</PartNumber><ETag>part-2</ETag>');
		parsedResponse = { CompleteMultipartUploadResult: { ETag: 'complete-etag' } };
		return response({
			text: '<CompleteMultipartUploadResult><ETag>complete-etag</ETag></CompleteMultipartUploadResult>',
		});
	});

	const uid = await s3.fs.writeStream(
		'Notes/big.bin',
		createStream([new Uint8Array(partSize), new Uint8Array(2)]),
		file('Notes/big.bin', { meta: () => ({ ctime: '300' }), size: partSize + 2 }),
	);
	expect(uid).toBe('complete-etag');
	expect(s3.calls.map(({ method }) => method)).toStrictEqual(['POST', 'PUT', 'PUT', 'POST']);
});

test('writeStream aborts multipart upload after part failure', async () => {
	const s3 = createS3Fs();
	const uploadError = new Error('part failed');
	const aborted = deferred<void>();
	s3.setRequest((url, params) => {
		const address = new URL(url);
		if (params.method === 'POST' && address.searchParams.has('uploads')) {
			parsedResponse = { InitiateMultipartUploadResult: { UploadId: 'upload-2' } };
			return response({
				text: '<InitiateMultipartUploadResult><UploadId>upload-2</UploadId></InitiateMultipartUploadResult>',
			});
		}
		if (params.method === 'PUT') throw uploadError;
		expect(params.method).toBe('DELETE');
		expect(address.searchParams.get('uploadId')).toBe('upload-2');
		aborted.resolve();
		return response({ status: 204 });
	});

	const source = createStream([bytes('failed')]);
	const destination = file('failed.bin', { size: 5 * 1024 * 1024 });
	expect(s3.fs.writeStream('failed.bin', source, destination)).rejects.toBe(uploadError);
	// The abort request is fire-and-forget, so wait for it to be issued.
	await aborted.promise;
	expect(s3.calls.map(({ method }) => method)).toStrictEqual(['POST', 'PUT', 'DELETE']);
});

test('delete and exists treat 404 as absent but propagate other statuses', async () => {
	const calls: Array<string> = [];
	const s3 = createS3Fs();
	s3.setRequest((_url, params) => {
		calls.push(params.method ?? '');
		if (calls.length === 1 || calls.length === 3) return response({ status: 404 });
		return response({ status: 500, text: '<Error><Code>InternalError</Code></Error>' });
	});
	await s3.fs.delete('gone');
	expect(s3.fs.delete('broken')).rejects.toMatchObject({ status: 500 });
	expect(await s3.fs.exists('missing')).toBe(false);
	expect(s3.fs.exists('broken')).rejects.toMatchObject({ status: 500 });

	const root = createS3Fs();
	expect(await root.fs.exists('/')).toBe(true);
});

test('batchDelete escapes keys, sends MD5 XML, and batches at 1000 keys', async () => {
	const s3 = createS3Fs();
	const bodies: Array<string> = [];
	s3.setRequest((url, params) => {
		expect(params.method).toBe('POST');
		const address = new URL(url);
		expect(address.searchParams.has('delete')).toBe(true);
		expect(params.headers?.['Content-Type']).toBe('application/xml');
		expect(params.headers?.['Content-MD5']).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
		const body = textBody(params);
		bodies.push(body);
		const hasSpecialKey = body.includes('<Key>a&lt;&amp;&quot;&apos;</Key>');
		parsedResponse = hasSpecialKey
			? {
					DeleteResult: {
						Error: {
							Code: 'AccessDenied',
							Key: 'a<&"\'',
							Message: 'no permission',
						},
					},
				}
			: { DeleteResult: {} };
		return response({
			status: 200,
			text: '<DeleteResult><Error><Key>a&lt;&amp;&quot;&apos;</Key><Code>AccessDenied</Code><Message>no permission</Message></Error></DeleteResult>',
		});
	});
	const keys = ['a<&"\''];
	for (let index = 0; index < 1000; index += 1) keys.push(`key-${index}`);
	const result = await s3.fs.batchDelete(keys);
	expect(bodies).toHaveLength(2);
	const objectCount = (body: string) => (body.match(/<Object>/gu) ?? []).length;
	const largeBatch = bodies.find((b) => objectCount(b) === 1000);
	const smallBatch = bodies.find((b) => objectCount(b) === 1);
	expect(largeBatch).toContain('<Key>a&lt;&amp;&quot;&apos;</Key>');
	expect(smallBatch).toBeDefined();
	expect(result['a<&"\'']?.message).toBe('S3 AccessDenied: no permission');
	expect(result['key-0']).toBeUndefined();
});

test('batch delete rejects only atoms with S3 partial failures', async () => {
	const s3 = createS3Fs();
	s3.setRequest(() => {
		parsedResponse = {
			DeleteResult: {
				Error: { Code: 'AccessDenied', Key: 'blocked.md', Message: 'not allowed' },
			},
		};
		return response({
			text: '<DeleteResult><Error><Key>blocked.md</Key><Code>AccessDenied</Code><Message>not allowed</Message></Error></DeleteResult>',
		});
	});

	const status = new Map<string, string>();
	const atoms: Array<InputAtom> = ['ok.md', 'blocked.md'].map((key) => ({
		execute: () => {},
		key,
		reject: (error) => status.set(key, `rejected: ${error.message}`),
		resolve: () => status.set(key, 'resolved'),
		type: 'delete',
	}));
	const optimized = s3BatchDeleteOptimizer({
		atoms,
		executeAtom: (atom) => Promise.resolve(atom.execute()),
		fs: s3.fs,
	} satisfies OptimizerInput);
	const batch = optimized?.[0];
	if (!batch) throw new Error('Expected batch delete atom');
	await batch.execute();

	expect(status).toStrictEqual(
		new Map([
			['ok.md', 'resolved'],
			['blocked.md', 'rejected: S3 AccessDenied: not allowed'],
		]),
	);
});

test('batchDelete retries each key individually when the batch request fails', async () => {
	const s3 = createS3Fs();
	const methods: Array<string> = [];
	parsedResponse = { Error: { Code: 'InternalError', Message: 'boom' } };
	s3.setRequest((url, params) => {
		methods.push(params.method ?? '');
		if (params.method === 'POST')
			return response({
				status: 500,
				text: '<Error><Code>InternalError</Code><Message>boom</Message></Error>',
			});
		expect(params.method).toBe('DELETE');
		if (url.endsWith('/broken.md'))
			return response({
				status: 500,
				text: '<Error><Code>InternalError</Code><Message>boom</Message></Error>',
			});
		return response({ status: 204 });
	});
	const result = await s3.fs.batchDelete(['ok.md', 'broken.md']);
	expect(result['ok.md']).toBeUndefined();
	expect(result['broken.md']?.message).toBe('S3 InternalError: boom');
	expect(methods).toStrictEqual(['POST', 'DELETE', 'DELETE']);
});

test('move copies encoded source before deleting old key', async () => {
	const s3 = createS3Fs();
	s3.setRequest((url, params) => {
		if (params.method === 'PUT') {
			expect(url).toBe('https://s3.example.com/vault/new%20folder/new.md');
			expect(params.headers).toMatchObject({
				'Content-Type': 'application/octet-stream',
				'x-amz-copy-source': 'vault/old%20folder/old.md',
			});
			return response();
		}
		expect(params.method).toBe('DELETE');
		expect(url).toBe('https://s3.example.com/vault/old%20folder/old.md');
		return response();
	});
	await s3.fs.move('old folder/old.md', 'new folder/new.md');
	expect(s3.calls.map(({ method }) => method)).toStrictEqual(['PUT', 'DELETE']);
});

test('mkdir recursively creates all ancestor placeholders', async () => {
	const s3 = createS3Fs();
	s3.setRequest((url, params) => {
		expect(params.method).toBe('PUT');
		expect(params.headers?.['Content-Type']).toBe('application/octet-stream');
		expect(params.body).toStrictEqual(new Uint8Array(0));
		return response({ status: 201 });
	});
	await s3.fs.mkdir('Notes/A B/Child/', folder('Notes/A B/Child/'), true);
	expect(s3.calls.map(({ url }) => url).sort()).toStrictEqual(
		[
			'https://s3.example.com/vault/Notes/',
			'https://s3.example.com/vault/Notes/A%20B/',
			'https://s3.example.com/vault/Notes/A%20B/Child/',
		].sort(),
	);
});

test('stat returns root, folder placeholders, and file metadata with ETag fallback', async () => {
	const s3 = createS3Fs();
	expect(await s3.fs.stat('/')).toStrictEqual({
		isDir: true,
		key: '/',
		// oxlint-disable-next-line typescript/no-unsafe-assignment
		meta: expect.any(Function),
	});
	s3.setRequest((url, params) => {
		expect(params.method).toBe('HEAD');
		if (url.endsWith('/folder/')) return response({ headers: { 'content-length': '0' } });
		return response({
			headers: {
				'content-length': '12',
				'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
				'x-amz-meta-ctime': '500',
			},
		});
	});
	expect(await s3.fs.stat('folder/')).toStrictEqual({
		isDir: true,
		key: 'folder/',
		// oxlint-disable-next-line typescript/no-unsafe-assignment
		meta: expect.any(Function),
	});
	const noteStat = await s3.fs.stat('note.md');
	expect(noteStat).toStrictEqual({
		isDir: false,
		key: 'note.md',
		// oxlint-disable-next-line typescript/no-unsafe-assignment
		meta: expect.any(Function),
		mtime: new Date('Mon, 01 Jan 2024 00:00:00 GMT').valueOf(),
		size: 12,
		uid: `${new Date('Mon, 01 Jan 2024 00:00:00 GMT').valueOf()}~12`,
	});
	if (noteStat.isDir) throw new Error('expected file stat');
	expect(await noteStat.meta()).toStrictEqual({ ctime: '500' });
});

test('list returns files and prefixes, excludes queried key, reports exclusions, and paginates', async () => {
	const s3 = createS3Fs();
	const progress: Array<string> = [];
	s3.setRequest((url, params) => {
		const address = new URL(url);
		expect(params.method).toBe('GET');
		expect(address.searchParams.get('list-type')).toBe('2');
		expect(address.searchParams.has('delimiter')).toBe(false);
		expect(address.searchParams.get('prefix')).toBe('Notes/');
		if (address.searchParams.has('continuation-token')) {
			expect(address.searchParams.get('continuation-token')).toBe('next-page');
			parsedResponse = {
				ListBucketResult: {
					Contents: {
						ETag: 'etag-2',
						Key: 'Notes/second.md',
						LastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
						Size: '2',
					},
					IsTruncated: 'false',
				},
			};
			return response({
				text: '<ListBucketResult><Contents><Key>Notes/second.md</Key><Size>2</Size><ETag>etag-2</ETag></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
			});
		}
		parsedResponse = {
			ListBucketResult: {
				Contents: [
					{ Key: 'Notes/' },
					{
						ETag: 'etag-1',
						Key: 'Notes/first.md',
						LastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
						Size: '1',
					},
					{ Key: 'Notes/folder/' },
				],
				IsTruncated: 'true',
				NextContinuationToken: 'next-page',
			},
		};
		return response({
			text: '<ListBucketResult><Contents><Key>Notes/</Key><Size>0</Size></Contents><Contents><Key>Notes/first.md</Key><Size>1</Size><ETag>etag-1</ETag><LastModified>Mon, 01 Jan 2024 00:00:00 GMT</LastModified></Contents><Contents><Key>Notes/folder/</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken></ListBucketResult>',
		});
	});

	const result = await s3.fs.list('Notes/', ({ current }) => {
		progress.push(current);
		return current === 'Notes/first.md' ? 'exclude' : 'include';
	});
	expect(result).toStrictEqual([
		{
			isDir: true,
			key: 'Notes/folder/',
			// oxlint-disable-next-line typescript/no-unsafe-assignment
			meta: expect.any(Function),
		},
		{
			isDir: false,
			key: 'Notes/second.md',
			// oxlint-disable-next-line typescript/no-unsafe-assignment
			meta: expect.any(Function),
			mtime: expect.any(Number) as never,
			size: 2,
			uid: 'etag-2',
		},
	]);
	expect(progress).toStrictEqual(['Notes/first.md', 'Notes/folder/', 'Notes/second.md']);
	expect(s3.calls).toHaveLength(2);
});

test('list maps unified root to an empty S3 prefix', async () => {
	const s3 = createS3Fs();
	s3.setRequest((url, _params) => {
		expect(new URL(url).searchParams.get('prefix')).toBe('');
		parsedResponse = { ListBucketResult: { IsTruncated: 'false' } };
		return response({ text: '<ListBucketResult />' });
	});

	expect(await s3.fs.list('/', () => 'include' as const)).toStrictEqual([]);
});

test('list provides meta via lazy HEAD per object', async () => {
	const s3 = createS3Fs();
	s3.setRequest((url, params) => {
		if (params.method === 'HEAD') return response({ headers: { 'x-amz-meta-ctime': '999' } });
		parsedResponse = {
			ListBucketResult: {
				Contents: {
					ETag: 'etag-1',
					Key: 'file.md',
					LastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
					Size: '1',
				},
				IsTruncated: 'false',
			},
		};
		return response({ text: '<ListBucketResult />' });
	});
	const [stat] = await s3.fs.list('/', () => 'include' as const);
	if (stat.isDir) throw new Error('expected file stat');
	expect(await stat.meta()).toStrictEqual({ ctime: '999' });
});

test('read populates meta cache so list stat meta() skips HEAD', async () => {
	const s3 = createS3Fs();
	let headCount = 0;
	s3.setRequest((url, params) => {
		if (params.method === 'GET') {
			if (!url.includes('list-type'))
				return response({
					body: bytes('data'),
					headers: { 'x-amz-meta-ctime': '42', 'x-amz-meta-mtime': '99' },
				});
			parsedResponse = {
				ListBucketResult: {
					Contents: {
						ETag: 'etag-1',
						Key: 'file.md',
						LastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
						Size: '1',
					},
					IsTruncated: 'false',
				},
			};
			return response({ text: '<ListBucketResult />' });
		}
		if (params.method === 'HEAD') {
			headCount++;
			return response({ headers: { 'x-amz-meta-ctime': '999' } });
		}
		return response();
	});
	const [stat] = await s3.fs.list('/', () => 'include' as const);
	if (stat.isDir) throw new Error('expected file stat');
	await s3.fs.read('file.md');
	expect(await stat.meta()).toStrictEqual({ ctime: '42', mtime: '99' });
	expect(headCount).toBe(0);
});

test.each(['stat', 'list'] as const)('%s rejects invalid file times and sizes', async (method) => {
	const validTime = '2024-01-01T00:00:00Z';
	for (const [lastModified, size] of [
		['invalid', '0'],
		[validTime, '-1'],
		[validTime, '1.5'],
		[validTime, '2junk'],
		[validTime, '1e3'],
		[validTime, '9007199254740992'],
	]) {
		const s3 = createS3Fs();
		s3.setRequest(() => {
			parsedResponse = {
				ListBucketResult: {
					Contents: { Key: 'note.md', LastModified: lastModified, Size: size },
				},
			};
			return response({ headers: { 'content-length': size, 'last-modified': lastModified } });
		});
		const operation =
			method === 'stat' ? s3.fs.stat('note.md') : s3.fs.list('/', () => 'advance');
		expect(operation).rejects.toThrow('Invalid S3 file stats: note.md');
		await operation.catch(() => {});
	}
});

test.each(['stat', 'list'] as const)(
	'%s accepts a zero-byte file at the Unix epoch',
	async (method) => {
		const s3 = createS3Fs();
		s3.setRequest(() => {
			parsedResponse = {
				ListBucketResult: {
					Contents: { Key: 'note.md', LastModified: '1970-01-01T00:00:00Z', Size: '0' },
				},
			};
			return response({
				headers: {
					'content-length': '0',
					'last-modified': 'Thu, 01 Jan 1970 00:00:00 GMT',
				},
			});
		});
		const stat =
			method === 'stat'
				? await s3.fs.stat('note.md')
				: (await s3.fs.list('/', () => 'advance'))[0];
		expect(stat).toMatchObject({ isDir: false, key: 'note.md', mtime: 0, size: 0, uid: '0~0' });
	},
);

test.each([{ Error: {} }, { Unexpected: {} }, { ListBucketResult: 'invalid' }])(
	'list rejects an invalid listing response %j',
	async (listing) => {
		const s3 = createS3Fs();
		s3.setRequest(() => {
			parsedResponse = listing;
			return response();
		});
		const operation = s3.fs.list('/', () => 'advance');
		expect(operation).rejects.toThrow();
		await operation.catch(() => {});
	},
);

test('list accepts an empty ListBucketResult', async () => {
	const s3 = createS3Fs();
	s3.setRequest(() => {
		parsedResponse = { ListBucketResult: '' };
		return response();
	});
	expect(await s3.fs.list('/', () => 'advance')).toEqual([]);
});

test.each([undefined, '', 'other.md'])(
	'list rejects a missing or out-of-scope key %s',
	async (key) => {
		const s3 = createS3Fs();
		s3.setRequest(() => {
			parsedResponse = { ListBucketResult: { Contents: { Key: key } } };
			return response();
		});
		const operation = s3.fs.list('vault/', () => 'advance');
		expect(operation).rejects.toThrow(key ? 'Out-of-scope S3 object' : 'Missing S3 object key');
		await operation.catch(() => {});
	},
);

test.each([
	['true', undefined],
	['true', ''],
	['1', ' \n '],
	['invalid', undefined],
] as const)('list rejects invalid pagination %s / %s', async (flag, token) => {
	const s3 = createS3Fs();
	s3.setRequest(() => {
		parsedResponse = {
			ListBucketResult: { IsTruncated: flag, NextContinuationToken: token },
		};
		return response();
	});
	const operation = s3.fs.list('/', () => 'advance');
	expect(operation).rejects.toThrow();
	await operation.catch(() => {});
});

test.each([{ tokens: ['same', 'same'] }, { tokens: ['a', 'b', 'a'] }])(
	'list rejects repeated pagination tokens $tokens',
	async ({ tokens }) => {
		const s3 = createS3Fs();
		let page = 0;
		s3.setRequest(() => {
			if (page >= tokens.length) throw new Error('Unexpected extra page request');
			parsedResponse = {
				ListBucketResult: { IsTruncated: 'true', NextContinuationToken: tokens[page++] },
			};
			return response();
		});
		const operation = s3.fs.list('/', () => 'advance');
		expect(operation).rejects.toThrow('Repeated S3 listing continuation token');
		await operation.catch(() => {});
		expect(s3.calls).toHaveLength(tokens.length);
	},
);

test.each(['false', '0', undefined])(
	'list stops on a completed page with flag %s',
	async (flag) => {
		const s3 = createS3Fs();
		s3.setRequest(() => {
			parsedResponse = {
				ListBucketResult: { IsTruncated: flag, NextContinuationToken: 'unused' },
			};
			return response();
		});
		expect(await s3.fs.list('/', () => 'advance')).toEqual([]);
		expect(s3.calls).toHaveLength(1);
	},
);

test('list accepts numeric pagination flags and preserves the continuation token', async () => {
	const s3 = createS3Fs();
	const token = ' next page +/= ';
	let page = 0;
	s3.setRequest((url) => {
		if (page++) expect(new URL(url).searchParams.get('continuation-token')).toBe(token);
		parsedResponse = {
			ListBucketResult: {
				IsTruncated: page === 1 ? ' 1 ' : ' 0 ',
				NextContinuationToken: token,
			},
		};
		return response();
	});
	expect(await s3.fs.list('/', () => 'advance')).toEqual([]);
	expect(s3.calls).toHaveLength(2);
});

test('list rejects a later failed page without returning partial results', async () => {
	const s3 = createS3Fs();
	let page = 0;
	s3.setRequest(() => {
		if (page++) {
			parsedResponse = { Error: { Code: 'AccessDenied' } };
			return response({ status: 403 });
		}
		parsedResponse = {
			ListBucketResult: {
				Contents: { Key: 'note.md', LastModified: '2024-01-01T00:00:00Z', Size: '0' },
				IsTruncated: 'true',
				NextContinuationToken: 'next',
			},
		};
		return response();
	});
	const operation = s3.fs.list('/', () => 'advance');
	expect(operation).rejects.toThrow('S3 AccessDenied');
	await operation.catch(() => {});
	expect(s3.calls).toHaveLength(2);
});
