import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectMachine,
  type MachineProbe,
  MACHINES_DIR,
  parseCpuinfo,
  parseMeminfo,
  readMachineFile,
  UNREGISTERED_DESCRIPTION,
} from '../src/machine';

// The first lines of each processor block of /proc/cpuinfo on the KVM host.
const EPYC_SAMPLE = [0, 1, 2, 3]
  .map((i) =>
    [
      `processor\t: ${i}`,
      'vendor_id\t: AuthenticAMD',
      'cpu family\t: 23',
      'model\t\t: 49',
      'model name\t: AMD EPYC-Rome Processor',
      'cpu MHz\t\t: 2794.748',
    ].join('\n')
  )
  .join('\n\n');

const MEMINFO =
  'MemTotal:        7931988 kB\nMemFree:         1149392 kB\nMemAvailable:    2272212 kB\n';

// A probe that answers from fixed values, so detection never reads this host.
const probe: MachineProbe = {
  cpuinfo: () => EPYC_SAMPLE,
  meminfo: () => MEMINFO,
  loadAvg1: () => 0.12,
  virtualization: () => 'kvm',
  os: () => 'Ubuntu 26.04 (Linux 7.0.0-27-generic x64)',
  bun: () => '1.3.0',
};

test('parseCpuinfo reads the model name and counts processors', () => {
  expect(parseCpuinfo(EPYC_SAMPLE)).toEqual({
    cpu: 'AMD EPYC-Rome Processor',
    vcpus: 4,
  });
});

test('parseMeminfo converts kB to bytes', () => {
  const mem = parseMeminfo('MemTotal: 8000000 kB\nMemAvailable: 2500000 kB\n');
  expect(mem.availableBytes).toBe(2_560_000_000);
  expect(mem.totalBytes).toBe(8_192_000_000);
});

test('parseMeminfo rejects text without MemAvailable', () => {
  expect(() => parseMeminfo('MemTotal: 8000000 kB\n')).toThrow('MemAvailable');
});

test('detectMachine combines the machine file with detected values', () => {
  expect(detectMachine('kvm-epyc-rome-4vcpu', { probe })).toEqual({
    id: 'kvm-epyc-rome-4vcpu',
    description:
      'Shared, virtualized KVM guest: 4 vCPU AMD EPYC Rome, 7 GB RAM. Client and server share the host.',
    cpu: 'AMD EPYC-Rome Processor',
    vcpus: 4,
    memoryBytes: 7_931_988 * 1024,
    virtualization: 'kvm',
    os: 'Ubuntu 26.04 (Linux 7.0.0-27-generic x64)',
    bun: '1.3.0',
    loadAvg1: 0.12,
    memAvailableBytes: 2_272_212 * 1024,
  });
});

test('an id without a machine file is described as unregistered', () => {
  const machine = detectMachine('local', { probe });
  expect(machine.id).toBe('local');
  expect(machine.description).toBe(UNREGISTERED_DESCRIPTION);
});

test('the detected machine on this host never names the hostname', () => {
  const machine = detectMachine('local');
  expect(machine.vcpus).toBeGreaterThan(0);
  expect(machine.bun).toBe(Bun.version);
  // This host is named `kvm`, which is also what systemd-detect-virt reports
  // for its hypervisor, so `virtualization` is left out of the check.
  const { virtualization: _virtualization, ...rest } = machine;
  expect(JSON.stringify(rest)).not.toContain(hostname());
});

test('every committed machine file is named after its id', () => {
  const files = readdirSync(MACHINES_DIR).filter((f) => f.endsWith('.json'));
  expect(files).toContain('kvm-epyc-rome-4vcpu.json');
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(MACHINES_DIR, file), 'utf8'));
    expect(Object.keys(parsed).sort()).toEqual(['description', 'id']);
    expect(`${parsed.id}.json`).toBe(file);
  }
});

test('readMachineFile rejects ids that are not plain names', () => {
  expect(readMachineFile('../package')).toBeUndefined();
  expect(readMachineFile('nope')).toBeUndefined();
});

test('readMachineFile rejects a file whose id does not match its name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-machines-'));
  try {
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify({ id: 'b', description: 'x' })
    );
    expect(() => readMachineFile('a', dir)).toThrow('id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
