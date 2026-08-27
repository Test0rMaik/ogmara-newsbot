/**
 * The bot's on-network identity: its display name, and its on-chain
 * registration status.
 *
 * Both are exposed as plain async functions taking explicit arguments rather
 * than being wired into the CLI, so the web control panel (P5) can call the
 * same code instead of reimplementing it.
 */

import { OgmaraClient, WalletSigner, getUserRegisteredAt, type ScNetwork } from '@ogmara/sdk';
import {
  KLV_PRECISION,
  REGISTRATION_COST_KLV,
  buildCallData,
  getAccount,
  invokeContract,
  stringToHex,
} from './klever.js';

/** What the bot's profile should say. */
export interface ProfileSpec {
  displayName?: string | undefined;
  bio?: string | undefined;
  avatarCid?: string | undefined;
}

/** Outcome of a profile sync. */
export type ProfileResult =
  | { status: 'updated'; displayName: string | undefined }
  | { status: 'nothing-to-do' };

/**
 * Publish the bot's profile to the node.
 *
 * A signed `ProfileUpdate` envelope like any other message, so it works for
 * unregistered wallets — the spec puts `ProfileUpdate` in the unverified-wallet
 * set. It is last-write-wins, so re-running is harmless.
 */
export async function applyProfile(
  client: OgmaraClient,
  spec: ProfileSpec,
): Promise<ProfileResult> {
  const data: { display_name?: string; bio?: string; avatar_cid?: string } = {};
  if (spec.displayName !== undefined) data.display_name = spec.displayName;
  if (spec.bio !== undefined) data.bio = spec.bio;
  if (spec.avatarCid !== undefined) data.avatar_cid = spec.avatarCid;

  if (Object.keys(data).length === 0) return { status: 'nothing-to-do' };

  await client.updateProfile(data);
  return { status: 'updated', displayName: spec.displayName };
}

/** The bot's on-chain registration state and what it implies. */
export interface RegistrationStatus {
  registered: boolean;
  /** Unix seconds of registration, 0 when unregistered. */
  registeredAt: number;
  /** Balance in whole KLV. */
  balanceKlv: number;
  /** Whether the wallet holds enough KLV to register. */
  canAfford: boolean;
}

/**
 * Read the wallet's registration state from the smart contract.
 *
 * Queried on-chain rather than via the node so the answer is authoritative
 * and does not depend on the node's chain-scanner having caught up.
 */
export async function checkRegistration(
  network: ScNetwork,
  address: string,
): Promise<RegistrationStatus> {
  const [registeredAt, account] = await Promise.all([
    getUserRegisteredAt(network, address),
    getAccount(network, address),
  ]);
  const balanceKlv = account.balance / KLV_PRECISION;
  return {
    registered: registeredAt > 0,
    registeredAt,
    balanceKlv,
    canAfford: balanceKlv >= REGISTRATION_COST_KLV,
  };
}

/** Outcome of a registration attempt. */
export type RegisterResult =
  | { status: 'already-registered'; registeredAt: number }
  | { status: 'insufficient-funds'; balanceKlv: number; requiredKlv: number }
  | { status: 'registered'; txHash: string; explorerUrl: string };

/**
 * Register the bot's wallet on-chain, unlocking the higher posting tier.
 *
 * **Spends real KLV and cannot be undone**, so this checks current status and
 * affordability first and never runs implicitly — the caller is responsible
 * for obtaining explicit operator consent before calling it.
 *
 * The contract takes the wallet's public key as a hex string, which is then
 * itself hex-encoded so the VM's `@` argument decoding delivers the 64 ASCII
 * characters rather than the 32 raw bytes they represent.
 */
export async function registerWallet(
  network: ScNetwork,
  signer: WalletSigner,
  privateKey: Uint8Array,
): Promise<RegisterResult> {
  const status = await checkRegistration(network, signer.address);
  if (status.registered) {
    return { status: 'already-registered', registeredAt: status.registeredAt };
  }
  if (!status.canAfford) {
    return {
      status: 'insufficient-funds',
      balanceKlv: status.balanceKlv,
      requiredKlv: REGISTRATION_COST_KLV,
    };
  }

  const data = buildCallData('register', [stringToHex(signer.publicKeyHex)]);
  const { txHash, explorerUrl } = await invokeContract(
    network,
    signer.address,
    privateKey,
    data,
  );
  return { status: 'registered', txHash, explorerUrl };
}
