/**
 * License key validation utility.
 *
 * Premium plugins require a valid license key to activate.
 * The key is loaded from config.json (plugins.licenseKey) or
 * the MOODLE_PLUGIN_KEY environment variable.
 *
 * This is lightweight — intended as a soft gate that makes casual
 * piracy inconvenient without being a DRM fortress. AGPL already
 * provides the strong legal protection.
 */

export interface LicenseValidationResult {
  valid: boolean;
  error?: string;
  identity?: string;
  expiresAt?: string;
}

const LICENSE_KEY_PATTERN = /^moodle-lic-[a-zA-Z0-9]{32}$/;

/**
 * Validate a license key string.
 *
 * Future: this can be extended to decode a JWT, check a signing
 * key, verify expiration, etc. For now it validates format + an
 * embedded checksum.
 */
export function validateLicense(key?: string): LicenseValidationResult {
  if (!key) {
    return { valid: false, error: "No license key provided. Set MOODLE_PLUGIN_KEY or plugins.licenseKey in config.json." };
  }

  // Validate format
  if (!LICENSE_KEY_PATTERN.test(key)) {
    return { valid: false, error: "Invalid license key format. Expected: moodle-lic-[32 hex chars]." };
  }

  // Extract and verify the embedded checksum
  const hexPart = key.replace("moodle-lic-", "");
  if (!verifyChecksum(hexPart)) {
    return { valid: false, error: "License key checksum failed — key may be malformed." };
  }

  return {
    valid: true,
    identity: `site:${hexPart.slice(0, 8)}`,
  };
}

/**
 * Simple XOR-based checksum verification over the hex string.
 * Not cryptographic — just enough to reject random strings.
 */
function verifyChecksum(hex: string): boolean {
  let sum = 0;
  for (let i = 0; i < hex.length; i++) {
    sum ^= hex.charCodeAt(i);
  }
  // The checksum byte is the last hex pair
  const checksumByte = parseInt(hex.slice(-2), 16);
  return (sum & 0xff) === checksumByte;
}
