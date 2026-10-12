import type { Fs } from '@hesprs/sync-engine-sdk';
import { omitEmptyFolders } from './directories';

export default function rcloneLocalWrapper(original: Fs, enabled: () => boolean): Fs {
	const list = original.list.bind(original);
	original.list = async (key, reporter) => {
		const stats = await list(key, reporter);
		return enabled() ? omitEmptyFolders(stats) : stats;
	};
	return original;
}
