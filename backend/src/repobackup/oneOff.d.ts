export type OneOffEnvelope = { iv: number[]; ciphertext: number[] };
export type OneOffRepository = {
  id: string;
  provider: string;
  name: string;
  repo_identifier: string;
  track_mode: "branch";
  track_ref: string;
  track_refs_json: string;
  target_mount_id: string;
  target_mount_ids_json: string;
  target_path_prefix: string;
  config_json: string;
};
export const ONE_OFF_TASK_PAYLOAD_SQL: string;
export function sealOneOffConfig(row: OneOffRepository, secret: string): Promise<OneOffEnvelope>;
export function openOneOffConfig(envelope: OneOffEnvelope, secret: string): Promise<OneOffRepository>;
