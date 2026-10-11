export const DbTables: Record<string, string>;

export const ApiStatus: Record<string, number>;

export const FILE_TYPES: Record<string, number>;
export const FILE_TYPE_NAMES: Record<string | number, string>;

export const DEFAULT_MAX_UPLOAD_SIZE_MB: number;

export const S3ProviderTypes: Record<string, string>;
/** provider_type 的历史取值（修改点：大仓库备份 CPU/耗时优化，只用于兼容分支） */
export const S3_PROVIDER_TYPE_LEGACY_OTHER: string;

export const UserType: {
  ADMIN: string;
  API_KEY: string;
  ANONYMOUS: string;
};
