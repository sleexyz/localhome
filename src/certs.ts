/**
 * Certificate generation for HTTPS MITM in localhome.
 * Uses node-forge to generate certs signed by mkcert's local CA.
 */

import forge from "node-forge";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

let caCert: forge.pki.Certificate | null = null;
let caKey: forge.pki.PrivateKey | null = null;

const certCache = new Map<string, { cert: string; key: string }>();

/** Find mkcert's CA root directory. */
function findCaRoot(): string | null {
  // 1. Environment variable
  if (process.env.MKCERT_CA_ROOT) return process.env.MKCERT_CA_ROOT;

  // 2. Try `mkcert -CAROOT` command
  try {
    const result = Bun.spawnSync(["mkcert", "-CAROOT"]);
    const dir = result.stdout.toString().trim();
    if (dir && existsSync(dir)) return dir;
  } catch {}

  // 3. Platform defaults
  const home = homedir();
  const candidates = [
    join(home, "Library", "Application Support", "mkcert"), // macOS
    join(home, ".local", "share", "mkcert"), // Linux
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "rootCA.pem"))) return dir;
  }

  return null;
}

/** Load the mkcert CA certificate and key. Returns true if successful. */
export async function loadCA(): Promise<boolean> {
  const caRoot = findCaRoot();
  if (!caRoot) {
    console.log("[certs] No mkcert CA found — HTTPS MITM disabled");
    return false;
  }

  const certPath = join(caRoot, "rootCA.pem");
  const keyPath = join(caRoot, "rootCA-key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.log(`[certs] CA files missing in ${caRoot} — HTTPS MITM disabled`);
    return false;
  }

  try {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    caCert = forge.pki.certificateFromPem(certPem);
    caKey = forge.pki.privateKeyFromPem(keyPem);
    console.log(`[certs] Loaded mkcert CA from ${caRoot}`);
    return true;
  } catch (e) {
    console.log(`[certs] Failed to load CA: ${e}`);
    return false;
  }
}

/** Check if MITM is available (CA loaded). */
export function isMitmAvailable(): boolean {
  return caCert !== null && caKey !== null;
}

/** Get or generate a cert/key pair for a hostname, signed by the CA. */
export function getCert(
  hostname: string
): { cert: string; key: string } | null {
  if (!caCert || !caKey) return null;

  const cached = certCache.get(hostname);
  if (cached) return cached;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(
    now.getTime() + 365 * 24 * 60 * 60 * 1000
  );

  const attrs = [{ name: "commonName", value: hostname }];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "subjectAltName",
      altNames: [{ type: 2, value: hostname }], // DNS
    },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const result = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };

  certCache.set(hostname, result);
  return result;
}
