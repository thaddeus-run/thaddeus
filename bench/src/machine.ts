import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { arch, cpus, freemem, loadavg, release, totalmem, type } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Machine } from './result';

// The committed machine descriptions, `bench/machines/<id>.json`.
export const MACHINES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'machines'
);

// The description of a machine with no file in bench/machines, such as a
// developer laptop or a CI runner.
export const UNREGISTERED_DESCRIPTION =
  'Unregistered machine: no description in bench/machines. Compare its numbers only with runs from the same host.';

// A machine file: the id results are filed under and a human description.
// The id stands in for the hostname, which results never name because the
// repository is public.
export interface MachineFile {
  id: string;
  description: string;
}

// Everything `detectMachine` reads from the host, so tests can supply fixed
// answers instead.
export interface MachineProbe {
  /** /proc/cpuinfo text. */
  cpuinfo(): string;
  /** /proc/meminfo text. */
  meminfo(): string;
  loadAvg1(): number;
  virtualization(): string;
  os(): string;
  bun(): string;
}

// Reads the real host. Off Linux, cpuinfo and meminfo are synthesized from
// node:os in the /proc format, so one parser serves both.
export const hostProbe: MachineProbe = {
  cpuinfo: () =>
    existsSync('/proc/cpuinfo')
      ? readFileSync('/proc/cpuinfo', 'utf8')
      : cpus()
          .map((c, i) => `processor\t: ${i}\nmodel name\t: ${c.model}\n`)
          .join('\n'),
  meminfo: () =>
    existsSync('/proc/meminfo')
      ? readFileSync('/proc/meminfo', 'utf8')
      : `MemTotal: ${Math.floor(totalmem() / 1024)} kB\nMemAvailable: ${Math.floor(freemem() / 1024)} kB\n`,
  loadAvg1: () => loadavg()[0] ?? 0,
  virtualization: detectVirtualization,
  os: describeOs,
  bun: () => Bun.version,
};

// `systemd-detect-virt` prints the hypervisor (`kvm`) or `none`. Where it is
// missing or prints nothing, the answer is `unknown`.
function detectVirtualization(): string {
  try {
    const result = Bun.spawnSync(['systemd-detect-virt'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = result.stdout.toString().trim();
    return out === '' ? 'unknown' : out;
  } catch {
    return 'unknown';
  }
}

// The distribution name from /etc/os-release when there is one, followed by
// the kernel and architecture, e.g. `Ubuntu 26.04 (Linux 7.0.0-27-generic x64)`.
function describeOs(): string {
  const kernel = `${type()} ${release()} ${arch()}`;
  if (!existsSync('/etc/os-release')) return kernel;
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(
    readFileSync('/etc/os-release', 'utf8')
  );
  return pretty?.[1] ? `${pretty[1]} (${kernel})` : kernel;
}

// The first `model name` and the number of `processor` entries.
export function parseCpuinfo(text: string): { cpu: string; vcpus: number } {
  let cpu = 'unknown';
  let vcpus = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === 'processor') vcpus += 1;
    else if (key === 'model name' && cpu === 'unknown')
      cpu = line.slice(colon + 1).trim();
  }
  return { cpu, vcpus };
}

// MemTotal and MemAvailable in bytes. /proc/meminfo says kB but means KiB.
export function parseMeminfo(text: string): {
  totalBytes: number;
  availableBytes: number;
} {
  const field = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text);
    if (match === null) throw new Error(`meminfo has no ${name} line`);
    return Number(match[1]) * 1024;
  };
  return {
    totalBytes: field('MemTotal'),
    availableBytes: field('MemAvailable'),
  };
}

// Reads `<dir>/<id>.json`, or returns undefined when there is none. Ids are
// plain lowercase names, so an id can never point outside the directory. A
// file whose `id` differs from its name is a mistake and throws.
export function readMachineFile(
  id: string,
  dir: string = MACHINES_DIR
): MachineFile | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return undefined;
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MachineFile;
  if (parsed.id !== id) {
    throw new Error(`${path} has id ${parsed.id}, expected ${id}`);
  }
  return parsed;
}

// The ids of every machine file in `dir`.
export function knownMachines(dir: string = MACHINES_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

// The machine block of a result: the committed description of `id` (or the
// unregistered one) plus what the probe reports right now. The load average
// and available memory are read once here, so the values a caller checks are
// the values the result records.
export function detectMachine(
  id: string,
  opts: { probe?: MachineProbe; machinesDir?: string } = {}
): Machine {
  const probe = opts.probe ?? hostProbe;
  const file = readMachineFile(id, opts.machinesDir);
  const { cpu, vcpus } = parseCpuinfo(probe.cpuinfo());
  const memory = parseMeminfo(probe.meminfo());
  return {
    id,
    description: file?.description ?? UNREGISTERED_DESCRIPTION,
    cpu,
    vcpus,
    memoryBytes: memory.totalBytes,
    virtualization: probe.virtualization(),
    os: probe.os(),
    bun: probe.bun(),
    loadAvg1: probe.loadAvg1(),
    memAvailableBytes: memory.availableBytes,
  };
}
