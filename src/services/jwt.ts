import { SignJWT, jwtVerify, importPKCS8, importSPKI, type KeyLike } from 'jose';
import { config } from '../config/env.js';

// Import keys ONCE at module load (top-level await in ESM)
// Saves 5-15ms per verify vs importing per request
let privateKey: KeyLike | Uint8Array;
let publicKey: KeyLike | Uint8Array;

try {
  privateKey = await importPKCS8(config.JWT_PRIVATE_KEY, 'RS256');
  publicKey = await importSPKI(config.JWT_PUBLIC_KEY, 'RS256');
} catch (err: any) {
  console.error('Failed to import RS256 JWT keys at startup:', err.message);
  process.exit(1);
}

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

export async function verifyToken(token: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'] // CRITICAL whitelist prevents alg:none and RS256->HS256 downgrade attacks
  });
  return payload as Record<string, unknown>;
}
