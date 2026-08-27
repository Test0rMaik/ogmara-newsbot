/**
 * Bech32 address validation.
 *
 * The SDK's `addressToPubkey` decodes bech32 *characters* but deliberately
 * does not verify the checksum — it is written for the hot path where the
 * address already came from a trusted source, and `sc_queries.ts` documents
 * the limitation. That is fine there and wrong here: a config file is typed by
 * a human, and a single mistyped character in an address decodes silently to a
 * *different* public key rather than failing.
 *
 * So this module implements the real BIP-173 checksum, which is what makes
 * bech32 typo-detecting in the first place.
 */

/** Bech32 character set (BIP-173). Excludes `1`, `b`, `i`, `o`. */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Generator constants for the bech32 polymod. */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

/** Why an address was rejected, for a message an operator can act on. */
export type AddressProblem =
  | 'malformed'
  | 'bad-charset'
  | 'bad-checksum'
  | 'wrong-prefix'
  | 'wrong-length';

/** BIP-173 checksum accumulator. */
function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk >>> 0;
}

/** Expand the human-readable part as the checksum requires. */
function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    high.push(c >>> 5);
    low.push(c & 31);
  }
  return [...high, 0, ...low];
}

/**
 * Validate a bech32 address, checksum included.
 *
 * @param address  The candidate address.
 * @param expectedHrp  Required human-readable part, e.g. `"klv"`.
 * @returns `undefined` when valid, otherwise why it was rejected.
 */
export function validateAddress(
  address: string,
  expectedHrp: string,
): AddressProblem | undefined {
  // Mixed case is invalid per BIP-173, and Klever addresses are lowercase.
  if (address !== address.toLowerCase()) return 'malformed';

  const sep = address.lastIndexOf('1');
  if (sep < 1 || sep + 7 > address.length) return 'malformed';

  const hrp = address.slice(0, sep);
  if (hrp !== expectedHrp) return 'wrong-prefix';

  const data: number[] = [];
  for (const ch of address.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return 'bad-charset';
    data.push(v);
  }

  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return 'bad-checksum';

  // 32-byte Ed25519 key → ceil(256/5) = 52 data characters, plus 6 checksum.
  if (data.length !== 58) return 'wrong-length';

  return undefined;
}

/** Human-readable explanation for a rejection, suitable for a config error. */
export function describeAddressProblem(problem: AddressProblem): string {
  switch (problem) {
    case 'malformed':
      return 'is not a well-formed bech32 address (lowercase, with a "1" separator)';
    case 'bad-charset':
      return 'contains characters that cannot appear in a bech32 address';
    case 'bad-checksum':
      return 'has an invalid checksum — check for a mistyped character';
    case 'wrong-prefix':
      return 'must be a wallet address starting with "klv1"';
    case 'wrong-length':
      return 'is the wrong length for a wallet address';
  }
}
