import type {
	FsWrapperEntry,
	ObsidianLanguageCode,
	SelectFromContext,
	SettingEntry,
	Translate,
	TranslationResource,
} from '@hesprs/sync-engine-sdk';
import { digOriginal } from '@hesprs/sync-engine-sdk';
import type { MetadataSettings, MetadataTranslations } from './setting';
import { en, zh, zhTW, ru } from './i18n';
import rcloneLocalWrapper from './local';
import RcloneFs from './remote';
import metadataSetting from './setting';

export default class S3Rclone {
	private readonly cleanup: Array<() => void> = [];
	private active = false;

	constructor(
		private readonly ctx: SelectFromContext<{
			settings: {
				remoteFs: string;
				modules: Record<string, object> & { encryption?: { enabled?: boolean } };
			};
			registerRemoteFsWrapper: (entry: FsWrapperEntry) => () => void;
			registerLocalFsWrapper: (entry: FsWrapperEntry) => () => void;
			registerSetting: (entry: SettingEntry) => () => void;
			registerI18n: (lang: ObsidianLanguageCode, resource: TranslationResource) => void;
			translate: Translate<MetadataTranslations>;
			saveSettings: () => Promise<void>;
		}>,
	) {
		ctx.registerI18n('en', en);
		ctx.registerI18n('zh', zh);
		ctx.registerI18n('zh-TW', zhTW);
		ctx.registerI18n('ru', ru);
	}

	readonly moduleSettings: MetadataSettings = { preferMetadataMtime: false };
	private readonly enabled = () =>
		this.active &&
		this.ctx.settings.remoteFs === 's3' &&
		!this.ctx.settings.modules.encryption?.enabled;

	readonly start = () => {
		this.active = true;
		this.cleanup.push(
			this.ctx.registerSetting({
				apply: metadataSetting(this.ctx, this.moduleSettings),
				priority: 1357,
			}),
			this.ctx.registerLocalFsWrapper({
				apply: (fs) => {
					if (this.enabled()) return rcloneLocalWrapper(fs, this.enabled);
				},
				priority: 500,
			}),
			this.ctx.registerRemoteFsWrapper({
				apply: (fs) => {
					if (!this.enabled()) return;
					const backend = digOriginal(fs) as ReturnType<typeof digOriginal> & {
						getMeta?: (key: string) => Promise<Dict<string>>;
					};
					if (!backend.getUid().startsWith('s3~')) return;
					if (typeof backend.getMeta !== 'function')
						throw new Error('S3 rclone requires S3 module 0.2.2 or later.');
					return new RcloneFs(fs, {
						enabled: this.enabled,
						getMeta: backend.getMeta.bind(backend),
						preferMetadataMtime: () => this.moduleSettings.preferMetadataMtime,
					});
				},
				priority: 500,
			}),
		);
	};

	readonly dispose = () => {
		this.active = false;
		this.cleanup.splice(0).forEach((fn) => fn());
	};
}
