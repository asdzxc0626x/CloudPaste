import { ValidationError } from "../http/errors.js";

// Keep task results, but discard the temporary execution configuration at every terminal transition.
export const ONE_OFF_TASK_PAYLOAD_SQL = "CASE WHEN json_valid(payload) THEN json_remove(payload, '$.oneOff') ELSE payload END";

async function taskKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Temporary task configuration must not expose credentials in task payloads or workflow outputs.
export async function sealOneOffConfig(row, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await taskKey(secret), new TextEncoder().encode(JSON.stringify(row)),
  );
  return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}

export async function openOneOffConfig(envelope, secret) {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(envelope.iv) }, await taskKey(secret), new Uint8Array(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new ValidationError("一次性备份配置已失效或无法解密，请重新提交");
  }
}
