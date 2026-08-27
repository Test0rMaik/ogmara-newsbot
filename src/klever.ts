/**
 * Minimal Klever transaction support — build, sign, broadcast.
 *
 * Used only for on-chain registration. The Ogmara node handles everything
 * else; this is the one operation that touches the Klever chain directly and
 * spends real funds.
 *
 * **Why the bot can do this at all.** The web client registers through
 * `window.kleverWeb` (the browser extension) because a browser never holds the
 * key. The bot holds the raw Ed25519 key already, so it signs locally — which
 * makes a headless flow simpler here than in the browser, not harder.
 *
 * The four-step flow is not obvious and is easy to get subtly wrong, so it is
 * spelled out: Klever's `/transaction/send` **builds** a transaction rather
 * than sending one, `/transaction/decode` is how you obtain the hash to sign,
 * the signature covers the hex-decoded 32-byte hash with no message prefix
 * (unlike Ogmara's message signing, which prefixes), and the signature goes
 * back as a base64 array on `Signature`.
 *
 * Ported from the verified implementation in `smart-contract/tools/lib.js`,
 * which was itself checked against l2-node's production anchoring code.
 */

import { SC_NETWORKS, type ScNetwork } from '@ogmara/sdk';
import { signAsync } from '@noble/ed25519';

/** Raised when a Klever RPC call fails in a way the operator must resolve. */
export class KleverError extends Error {
  override readonly name = 'KleverError';
}

/** Klever account state relevant to sending a transaction. */
export interface KleverAccount {
  /** Next transaction nonce. */
  nonce: number;
  /** Balance in the smallest KLV unit (6 decimals — 1 KLV = 1_000_000). */
  balance: number;
}

/** Smallest-unit divisor for KLV (6 decimals). */
export const KLV_PRECISION = 1_000_000;

/**
 * Cost of an on-chain registration, in whole KLV.
 *
 * ~2 KLV contract fee plus bandwidth. Used only to warn the operator before
 * they spend; the chain is authoritative on the actual charge.
 */
export const REGISTRATION_COST_KLV = 4.4;

/** The Klever RPC base and Ogmara KApp address for a network. */
export function kleverNetwork(network: ScNetwork): { rpc: string; sc: string } {
  const cfg = SC_NETWORKS[network];
  return { rpc: cfg.rpc.replace(/\/+$/, ''), sc: cfg.sc };
}

/** Fetch an account's nonce and balance. A missing account is nonce 0. */
export async function getAccount(network: ScNetwork, address: string): Promise<KleverAccount> {
  // The account endpoint lives on the API host, which mirrors the RPC host
  // with `node.` swapped for `api.`.
  const apiUrl = kleverNetwork(network).rpc.replace('//node.', '//api.');
  const resp = await fetch(`${apiUrl}/v1.0/address/${address}`);
  if (resp.status === 404) return { nonce: 0, balance: 0 };
  if (!resp.ok) {
    throw new KleverError(`Klever account lookup failed: HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { data?: { account?: { nonce?: number; balance?: number } } };
  const account = body.data?.account ?? {};
  return { nonce: account.nonce ?? 0, balance: account.balance ?? 0 };
}

/** UTF-8 bytes of a string as lowercase hex. */
export function stringToHex(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Encode `functionName@hexArg…` as the base64 call-data Klever expects. */
export function buildCallData(functionName: string, hexArgs: readonly string[]): string {
  return bytesToBase64(new TextEncoder().encode([functionName, ...hexArgs].join('@')));
}

/** Result of a successful broadcast. */
export interface BroadcastResult {
  txHash: string;
  explorerUrl: string;
}

/**
 * Build, sign and broadcast a smart-contract invocation.
 *
 * @param network   Which Klever chain.
 * @param address   The bot's `klv1…` address.
 * @param privateKey Raw 32-byte Ed25519 private key.
 * @param dataB64   Base64 call data from {@link buildCallData}.
 */
export async function invokeContract(
  network: ScNetwork,
  address: string,
  privateKey: Uint8Array,
  dataB64: string,
): Promise<BroadcastResult> {
  const net = kleverNetwork(network);
  const { nonce } = await getAccount(network, address);

  const contract = {
    scType: 0, // InvokeContract
    address: net.sc,
    callValue: {},
  };

  // Step 1 — BUILD. Despite the name, /transaction/send does not send: it
  // returns an unsigned transaction for us to sign.
  const built = await postJson(`${net.rpc}/transaction/send`, {
    type: 63, // SmartContract
    sender: address,
    nonce,
    permID: 0,
    data: [dataB64],
    contract,
    contracts: [contract],
    kdaFee: '',
  });

  const rawTx = (built as { data?: { result?: unknown } }).data?.result;
  if (rawTx === undefined || rawTx === null) {
    throw new KleverError(`Klever did not return a built transaction: ${JSON.stringify(built)}`);
  }
  // A Klever quirk: the response can carry BOTH `data.result` and `error` —
  // e.g. "nil address in GetExistingAccount" for a brand-new account that has
  // never transacted. The build is still valid, so proceed on the presence of
  // a result rather than the absence of an error.

  // Step 2 — DECODE, purely to obtain the hash that must be signed.
  const decoded = await postJson(`${net.rpc}/transaction/decode`, rawTx);
  const hash = (decoded as { data?: { tx?: { hash?: string } } }).data?.tx?.hash;
  if (hash === undefined || hash.length === 0) {
    throw new KleverError(`Klever did not return a transaction hash: ${JSON.stringify(decoded)}`);
  }

  // Step 3 — SIGN the hex-decoded 32-byte hash directly. Note this is NOT the
  // Ogmara message-signing format, which prepends a prefix and Keccak-hashes;
  // a transaction signature covers the raw hash bytes with no prefix.
  const signature = await signAsync(hexToBytes(hash), privateKey);

  // Step 4 — BROADCAST with the signature attached as a base64 array.
  const signedTx = { ...(rawTx as Record<string, unknown>), Signature: [bytesToBase64(signature)] };
  const result = await postJson(`${net.rpc}/transaction/broadcast`, { tx: signedTx });
  const error = (result as { error?: string }).error;
  if (error !== undefined && error.length > 0) {
    throw new KleverError(`Klever rejected the transaction: ${error}`);
  }

  const explorerHost =
    network === 'mainnet' ? 'https://kleverscan.org' : 'https://testnet.kleverscan.org';
  return { txHash: hash, explorerUrl: `${explorerHost}/transaction/${hash}` };
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new KleverError(`Klever RPC ${url} returned HTTP ${resp.status}`);
  }
  return resp.json();
}
