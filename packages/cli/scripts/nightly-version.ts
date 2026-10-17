// Nightly version scheme adapted from pingdotgg/t3code's release workflow at
// 2fae0f9: the next patch after the checked-in release, tagged with the UTC
// build date and the workflow run number, e.g. 0.1.11-nightly.20261017.42.
// The patch bump makes every nightly sort above the release it was cut from.
import { parseArgs } from 'node:util';

const BASE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Compute the nightly version for `base` (any x.y.z, with or without a
// prerelease suffix), the build's UTC date and a positive run number.
export function nightlyVersion(base: string, date: Date, run: number): string {
  const match = BASE.exec(base);
  if (match === null) {
    throw new Error(
      `invalid base version ${JSON.stringify(base)}; expected <major>.<minor>.<patch>`
    );
  }
  if (!Number.isSafeInteger(run) || run < 1) {
    throw new Error(`invalid run number ${run}; expected a positive integer`);
  }
  if (Number.isNaN(date.getTime())) throw new Error('invalid build date');
  const [, major, minor, patch] = match;
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `${major}.${minor}.${Number(patch) + 1}-nightly.${day}.${run}`;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        base: { type: 'string' },
        date: { type: 'string' },
        run: { type: 'string' },
      },
      strict: true,
    });
    if (!values.base || !values.date || !values.run) {
      throw new Error(
        'usage: nightly-version.ts --base <version> --date <iso> --run <n>'
      );
    }
    if (!/^[1-9]\d*$/.test(values.run)) {
      throw new Error(`invalid run number ${JSON.stringify(values.run)}`);
    }
    console.log(
      nightlyVersion(values.base, new Date(values.date), Number(values.run))
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
