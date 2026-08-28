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
import { uploadImageBytes } from './media.js';

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

/**
 * Read the bot's own profile back from the node.
 *
 * Used by the control panel's Settings tab so it can show what's actually
 * set — without this, the display-name field always started blank, which
 * looked like "no name is set" even when one genuinely was, since nothing
 * ever populated the input with the current value.
 */
export async function fetchProfile(client: OgmaraClient, address: string): Promise<ProfileSpec> {
  const { user } = await client.getUserProfile(address);
  return {
    ...(user.display_name !== undefined ? { displayName: user.display_name } : {}),
    ...(user.bio !== undefined ? { bio: user.bio } : {}),
    ...(user.avatar_cid !== undefined ? { avatarCid: user.avatar_cid } : {}),
  };
}

/**
 * Largest avatar image accepted, in bytes. Avatars are small by nature; this
 * is generous headroom without inviting someone to upload something IPFS
 * has to pin at full node-upload-cap size just to be a profile picture.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Upload an avatar image and set it as the bot's profile picture in one step.
 *
 * Reuses `media.ts`'s `uploadImageBytes` — the exact same magic-byte-verified,
 * allowlisted (jpeg/png/gif/webp only) upload path the RSS-image feature
 * uses — rather than a separate, looser check for panel-uploaded images. An
 * operator's own upload is more trusted than a hostile feed's, but there's
 * no reason to skip a validation that costs nothing and closes the same
 * class of "claimed image type doesn't match the actual bytes" gap either
 * way.
 */
export async function uploadAvatar(
  client: OgmaraClient,
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<{ avatarCid: string }> {
  const attachment = await uploadImageBytes(client, bytes, filename, mimeType, MAX_AVATAR_BYTES);
  await applyProfile(client, { avatarCid: attachment.cid });
  return { avatarCid: attachment.cid };
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
