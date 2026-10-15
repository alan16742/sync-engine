import syncEngineModule from '@hesprs/sync-engine-sdk/tsdown-plugin';
import moduleCatalog from '@repo/shared/module-catalog';
import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: process.env.MODE !== 'dev',
	dts: false,
	entry: { s3: 'src/index.ts' },
	inputOptions: { resolve: { alias: { 'hash-wasm': 'hash-wasm/dist/index.esm.js' } } },
	minify: true,
	outExtensions: () => ({ js: '.js' }),
	outputOptions: { codeSplitting: false },
	plugins: [syncEngineModule(moduleCatalog)],
});
