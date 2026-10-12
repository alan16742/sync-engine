import type { MetadataTranslations } from './setting';

export const en: MetadataTranslations = {
	s3Rclone: 'S3 rclone',
	s3RclonePreferMetadataMtime: 'Prefer metadata modification time on download',
	s3RclonePreferMetadataMtimeDescription:
		'Restore the local file modification time from x-amz-meta-mtime when valid; otherwise use the remote file modification time.',
};

export const zh: MetadataTranslations = {
	s3Rclone: 'S3 rclone',
	s3RclonePreferMetadataMtime: '下载时优先使用元数据修改时间',
	s3RclonePreferMetadataMtimeDescription:
		'使用有效的 x-amz-meta-mtime 恢复本地文件的修改时间；缺失或无效时使用远端文件的修改时间。',
};

export const zhTW: MetadataTranslations = {
	s3Rclone: 'S3 rclone',
	s3RclonePreferMetadataMtime: '下載時優先使用中繼資料修改時間',
	s3RclonePreferMetadataMtimeDescription:
		'使用有效的 x-amz-meta-mtime 還原本機檔案的修改時間；缺少或無效時使用遠端檔案的修改時間。',
};

export const ru: MetadataTranslations = {
	s3Rclone: 'S3 rclone',
	s3RclonePreferMetadataMtime: 'Использовать время изменения из метаданных при скачивании',
	s3RclonePreferMetadataMtimeDescription:
		'Восстановить время изменения локального файла из корректного x-amz-meta-mtime; иначе использовать время изменения удалённого файла.',
};
