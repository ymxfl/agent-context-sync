import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix = 'ws' | 'preview' | 'packet' | 'kn';

function encodeCrockfordBase32(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${encodeCrockfordBase32(randomBytes(16))}`;
}
