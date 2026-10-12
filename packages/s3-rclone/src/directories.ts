import type { Stat } from '@hesprs/sync-engine-sdk';
import { dirname } from '@repo/shared/path';

export function nonEmptyFolders(stats: Array<Stat>): Set<string> {
	const folders = new Set<string>();
	for (const stat of stats) {
		if (stat.isDir) continue;
		for (let parent = dirname(stat.key); parent !== '/'; parent = dirname(parent)) {
			if (folders.has(parent)) break;
			folders.add(parent);
		}
	}
	return folders;
}

export function omitEmptyFolders(stats: Array<Stat>): Array<Stat> {
	const folders = nonEmptyFolders(stats);
	return stats.filter((stat) => !stat.isDir || folders.has(stat.key));
}
