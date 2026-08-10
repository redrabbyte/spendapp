export interface Me {
  id: string;
  username: string | null;
  displayName: string;
  /** base64url X25519 public key; present once the account has keys. */
  publicKey?: string | null;
  /** Which privacy policy wording this account accepted; null if none yet. */
  privacyVersion?: string | null;
}
