import {
  DescribeKeyCommand,
  type DescribeKeyCommandOutput,
  GetPublicKeyCommand,
  type GetPublicKeyCommandOutput,
  KMSClient,
  SignCommand,
  type SignCommandOutput,
} from '@aws-sdk/client-kms';
import { encodeDidKey, PublicIdentity } from '@thaddeus.run/identity';
import type { AttestationSigner } from '@thaddeus.run/reputation';
import { createPublicKey } from 'node:crypto';

const ED25519_KEY_SPEC = 'ECC_NIST_EDWARDS25519';
const ED25519_SIGNING_ALGORITHM = 'ED25519_SHA_512';

export interface KmsOperations {
  describeKey(keyId: string): Promise<DescribeKeyCommandOutput>;
  getPublicKey(keyId: string): Promise<GetPublicKeyCommandOutput>;
  sign(keyId: string, message: Uint8Array): Promise<SignCommandOutput>;
}

function regionFromExactKeyArn(keyArn: string): string {
  const match =
    /^arn:(?:aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9-]+$/.exec(
      keyArn
    );
  if (match?.[1] === undefined) {
    throw new TypeError('attestation KMS key must be an exact AWS KMS key ARN');
  }
  return match[1];
}

function operationsFor(keyArn: string): KmsOperations {
  const client = new KMSClient({ region: regionFromExactKeyArn(keyArn) });
  return {
    describeKey: (keyId) =>
      client.send(new DescribeKeyCommand({ KeyId: keyId })),
    getPublicKey: (keyId) =>
      client.send(new GetPublicKeyCommand({ KeyId: keyId })),
    sign: (keyId, message) =>
      client.send(
        new SignCommand({
          KeyId: keyId,
          Message: message,
          MessageType: 'RAW',
          SigningAlgorithm: ED25519_SIGNING_ALGORITHM,
        })
      ),
  };
}

// KMS returns DER SubjectPublicKeyInfo. Node's standards parser avoids binding
// the DID derivation to a hand-written ASN.1 offset.
function didFromSubjectPublicKeyInfo(publicKey: Uint8Array): string {
  let jwk: { kty?: string; crv?: string; x?: string };
  try {
    jwk = createPublicKey({
      key: Buffer.from(publicKey),
      format: 'der',
      type: 'spki',
    }).export({ format: 'jwk' }) as {
      kty?: string;
      crv?: string;
      x?: string;
    };
  } catch {
    throw new TypeError('KMS returned a malformed Ed25519 public key');
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.x === undefined) {
    throw new TypeError('KMS public key is not Ed25519');
  }
  const raw = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  if (raw.byteLength !== 32) {
    throw new TypeError('KMS returned an invalid Ed25519 public key length');
  }
  return encodeDidKey(raw);
}

/** Resolves and validates an AWS KMS-backed reputation attestation signer. */
export async function createAwsKmsAttestationSigner(
  keyArn: string,
  operations: KmsOperations = operationsFor(keyArn)
): Promise<AttestationSigner> {
  regionFromExactKeyArn(keyArn);
  const described = await operations.describeKey(keyArn);
  const metadata = described.KeyMetadata;
  if (
    metadata?.Arn !== keyArn ||
    metadata.KeyManager !== 'CUSTOMER' ||
    metadata.Origin !== 'AWS_KMS' ||
    metadata.Enabled !== true ||
    metadata.KeyState !== 'Enabled' ||
    metadata.KeyUsage !== 'SIGN_VERIFY' ||
    metadata.KeySpec !== ED25519_KEY_SPEC
  ) {
    throw new TypeError(
      'KMS key must be an enabled AWS-origin customer Ed25519 SIGN_VERIFY key'
    );
  }

  const publicResult = await operations.getPublicKey(keyArn);
  if (
    publicResult.KeyUsage !== 'SIGN_VERIFY' ||
    publicResult.KeySpec !== ED25519_KEY_SPEC ||
    publicResult.SigningAlgorithms === undefined ||
    !publicResult.SigningAlgorithms.includes(ED25519_SIGNING_ALGORITHM) ||
    publicResult.PublicKey === undefined
  ) {
    throw new TypeError('KMS key does not support Ed25519 signing');
  }
  const did = didFromSubjectPublicKeyInfo(publicResult.PublicKey);
  const publicIdentity = PublicIdentity.fromDid(did);

  return {
    did,
    sign: async (message) => {
      const result = await operations.sign(keyArn, message);
      const signature = result.Signature;
      if (
        signature === undefined ||
        signature.byteLength !== 64 ||
        !publicIdentity.verify(message, signature)
      ) {
        throw new Error('KMS returned an invalid Ed25519 signature');
      }
      return signature;
    },
  };
}
