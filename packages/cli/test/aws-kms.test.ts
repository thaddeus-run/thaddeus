import type {
  DescribeKeyCommandOutput,
  GetPublicKeyCommandOutput,
  SignCommandOutput,
} from '@aws-sdk/client-kms';
import { ready } from '@thaddeus.run/identity';
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  createAwsKmsAttestationSigner,
  type KmsOperations,
} from '../src/aws-kms';

const ARN =
  'arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555';

beforeAll(async () => {
  await ready();
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected promise to reject');
}

function fixture(): {
  operations: KmsOperations;
  describe: DescribeKeyCommandOutput;
  publicResult: GetPublicKeyCommandOutput;
} {
  const pair = generateKeyPairSync('ed25519');
  const describe = {
    $metadata: {},
    KeyMetadata: {
      KeyId: '11111111-2222-3333-4444-555555555555',
      Arn: ARN,
      KeyManager: 'CUSTOMER',
      Origin: 'AWS_KMS',
      Enabled: true,
      KeyState: 'Enabled',
      KeyUsage: 'SIGN_VERIFY',
      KeySpec: 'ECC_NIST_EDWARDS25519',
    },
  } satisfies DescribeKeyCommandOutput;
  const publicResult = {
    $metadata: {},
    KeyUsage: 'SIGN_VERIFY',
    KeySpec: 'ECC_NIST_EDWARDS25519',
    SigningAlgorithms: ['ED25519_SHA_512'],
    PublicKey: new Uint8Array(
      pair.publicKey.export({ format: 'der', type: 'spki' })
    ),
  } satisfies GetPublicKeyCommandOutput;
  const operations: KmsOperations = {
    describeKey: () => Promise.resolve(describe),
    getPublicKey: () => Promise.resolve(publicResult),
    sign: (_keyId, message) =>
      Promise.resolve({
        $metadata: {},
        Signature: new Uint8Array(
          sign(null, Buffer.from(message), pair.privateKey)
        ),
      } satisfies SignCommandOutput),
  };
  return { operations, describe, publicResult };
}

describe('AWS KMS attestation signer', () => {
  test('validates the key and verifies signatures locally', async () => {
    const { operations } = fixture();
    const signer = await createAwsKmsAttestationSigner(ARN, operations);
    const message = new TextEncoder().encode('canonical contribution');
    expect(signer.did).toStartWith('did:key:');
    expect(await signer.sign(message)).toHaveLength(64);
  });

  test('requires an exact key ARN', async () => {
    const { operations } = fixture();
    expect(
      await rejectionMessage(
        createAwsKmsAttestationSigner('alias/thaddeus', operations)
      )
    ).toContain('exact AWS KMS key ARN');
  });

  test('rejects unsafe metadata and unsupported algorithms', async () => {
    for (const mutate of [
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.KeyManager = 'AWS';
      },
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.Origin = 'EXTERNAL';
      },
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.Enabled = false;
      },
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.KeyState = 'Disabled';
      },
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.KeyUsage = 'ENCRYPT_DECRYPT';
      },
      (value: DescribeKeyCommandOutput) => {
        value.KeyMetadata!.KeySpec = 'ECC_NIST_P256';
      },
    ]) {
      const invalid = fixture();
      mutate(invalid.describe);
      expect(
        await rejectionMessage(
          createAwsKmsAttestationSigner(ARN, invalid.operations)
        )
      ).toContain('enabled AWS-origin customer Ed25519 SIGN_VERIFY key');
    }

    const second = fixture();
    second.publicResult.SigningAlgorithms = ['ECDSA_SHA_256'];
    expect(
      await rejectionMessage(
        createAwsKmsAttestationSigner(ARN, second.operations)
      )
    ).toContain('does not support Ed25519');
  });

  test('rejects malformed public keys and invalid signatures', async () => {
    const first = fixture();
    first.publicResult.PublicKey = new Uint8Array([1, 2, 3]);
    expect(
      await rejectionMessage(
        createAwsKmsAttestationSigner(ARN, first.operations)
      )
    ).toContain('malformed Ed25519 public key');

    const second = fixture();
    second.operations.sign = () =>
      Promise.resolve({
        $metadata: {},
        Signature: new Uint8Array(64),
      } satisfies SignCommandOutput);
    const signer = await createAwsKmsAttestationSigner(ARN, second.operations);
    expect(await rejectionMessage(signer.sign(new Uint8Array([1])))).toContain(
      'invalid Ed25519 signature'
    );

    const absent = fixture();
    absent.operations.sign = () =>
      Promise.resolve({ $metadata: {} } satisfies SignCommandOutput);
    const absentSigner = await createAwsKmsAttestationSigner(
      ARN,
      absent.operations
    );
    expect(
      await rejectionMessage(absentSigner.sign(new Uint8Array([1])))
    ).toContain('invalid Ed25519 signature');
  });

  test('propagates startup and runtime KMS failures', async () => {
    const startup = fixture();
    startup.operations.describeKey = () => Promise.reject(new Error('offline'));
    expect(
      await rejectionMessage(
        createAwsKmsAttestationSigner(ARN, startup.operations)
      )
    ).toContain('offline');

    const runtime = fixture();
    runtime.operations.sign = () => Promise.reject(new Error('throttled'));
    const signer = await createAwsKmsAttestationSigner(ARN, runtime.operations);
    expect(await rejectionMessage(signer.sign(new Uint8Array([1])))).toContain(
      'throttled'
    );
  });
});
