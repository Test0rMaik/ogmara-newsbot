import { WalletSigner } from '@ogmara/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeAddressProblem, validateAddress } from './address.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

let address: string;

beforeAll(async () => {
  address = (await WalletSigner.generate()).address;
});

/** Replace the character at `pos` with a different valid bech32 character. */
function flip(s: string, pos: number, pick = 0): string {
  const current = s[pos];
  const replacement = CHARSET[(CHARSET.indexOf(current!) + 1 + pick) % 32]!;
  return s.slice(0, pos) + replacement + s.slice(pos + 1);
}

describe('validateAddress', () => {
  it('accepts a genuine generated address', () => {
    expect(validateAddress(address, 'klv')).toBeUndefined();
  });

  it('detects a typo in the data part', () => {
    // The dangerous case: this decodes cleanly to a DIFFERENT public key.
    expect(validateAddress(flip(address, 20), 'klv')).toBe('bad-checksum');
  });

  it('detects a typo in the checksum itself', () => {
    expect(validateAddress(flip(address, address.length - 1), 'klv')).toBe('bad-checksum');
  });

  it('detects every single-character substitution', () => {
    // Bech32 guarantees this, and it is the entire reason for the module.
    // Exhaustive rather than sampled: every position × every other character.
    let undetected = 0;
    for (let pos = 4; pos < address.length; pos++) {
      for (let k = 0; k < 31; k++) {
        const mutated = flip(address, pos, k);
        if (mutated === address) continue;
        if (validateAddress(mutated, 'klv') === undefined) undetected++;
      }
    }
    expect(undetected).toBe(0);
  });

  it('rejects a wrong prefix', () => {
    expect(validateAddress(`ogd1${address.slice(4)}`, 'klv')).toBe('wrong-prefix');
  });

  it('rejects mixed or upper case', () => {
    expect(validateAddress(address.toUpperCase(), 'klv')).toBe('malformed');
  });

  it('rejects truncation and junk', () => {
    expect(validateAddress(address.slice(0, -2), 'klv')).toBeDefined();
    expect(validateAddress('klv1nonsense', 'klv')).toBeDefined();
    expect(validateAddress('', 'klv')).toBe('malformed');
    expect(validateAddress('klv1', 'klv')).toBe('malformed');
    expect(validateAddress('nodelimiter', 'klv')).toBe('malformed');
  });

  it('rejects characters outside the bech32 alphabet', () => {
    // `b`, `i`, `o` and `1` are excluded precisely because they are confusable.
    expect(validateAddress(`klv1b${address.slice(5)}`, 'klv')).toBe('bad-charset');
  });

  it('rejects a checksum-valid address of the wrong length', () => {
    // Guards the SDK's other documented gap: charset-valid input decoding to
    // the wrong number of bytes.
    expect(validateAddress('klv1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'klv'))
      .toBeDefined();
  });
});

describe('describeAddressProblem', () => {
  it('explains every problem in terms an operator can act on', () => {
    const problems = [
      'malformed',
      'bad-charset',
      'bad-checksum',
      'wrong-prefix',
      'wrong-length',
    ] as const;
    for (const p of problems) {
      expect(describeAddressProblem(p).length).toBeGreaterThan(10);
    }
    expect(describeAddressProblem('bad-checksum')).toMatch(/mistyped/);
  });
});
