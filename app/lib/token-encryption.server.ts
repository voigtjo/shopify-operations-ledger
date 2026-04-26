import { createCipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";

function getEncryptionKey() {
  const secret = process.env.OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      "OPERATIONS_LEDGER_TOKEN_ENCRYPTION_KEY is required to store Shopify installation tokens",
    );
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptAccessToken(accessToken: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(accessToken, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}
