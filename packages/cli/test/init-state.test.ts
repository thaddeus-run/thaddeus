import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { prepareIgnore } from '../src/ignore';
import { beginInitState, initJournalPath } from '../src/init-state';

const tmp = mkdtempSync(join(tmpdir(), 'thaddeus-init-state-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function setup() {
  return {
    root: mkdtempSync(join(tmp, 'root-')),
    home: mkdtempSync(join(tmp, 'home-')),
    repo: 'r',
    server: 'http://t',
    owner: 'owner',
  };
}

test('rollback preserves source files and unrelated installation metadata', () => {
  const input = setup();
  mkdirSync(join(input.root, '.thaddeus', 'bin'), { recursive: true });
  writeFileSync(join(input.root, '.thaddeus', 'bin', 'keep'), 'binary');
  writeFileSync(join(input.root, 'a.txt'), 'original');
  const state = beginInitState(input);
  expect(() => beginInitState(input)).toThrow('init lock');
  state.rollback();
  state.finish();
  expect(readFileSync(join(input.root, 'a.txt'), 'utf8')).toBe('original');
  expect(
    readFileSync(join(input.root, '.thaddeus', 'bin', 'keep'), 'utf8')
  ).toBe('binary');
  expect(readdirSync(join(input.root, '.thaddeus'))).toEqual(['bin']);
});

test('config is published last and existing ignore files are never replaced', () => {
  const input = setup();
  writeFileSync(join(input.root, '.gitignore'), '.env\n');
  const prepared = prepareIgnore(input.root);
  const state = beginInitState(input);
  mkdirSync(join(state.stage, 'store'));
  writeFileSync(join(state.stage, 'store', 'record'), 'data');
  writeFileSync(join(input.root, '.thaddeusignore'), 'user edit\n');
  expect(() =>
    state.publish({ server: input.server, repo: 'r', base: [] }, prepared)
  ).toThrow();
  state.rollback();
  state.finish();
  expect(existsSync(join(input.root, '.thaddeus', 'config.json'))).toBe(false);
  expect(existsSync(join(input.root, '.thaddeus', 'store'))).toBe(false);
  expect(readFileSync(join(input.root, '.thaddeusignore'), 'utf8')).toBe(
    'user edit\n'
  );
});

test('uncertain creation resumes with matching identity and preserves successful config', () => {
  const input = setup();
  const first = beginInitState(input);
  first.mark('create-attempted');
  first.rollback();
  first.release();
  expect(() => beginInitState({ ...input, owner: 'someone-else' })).toThrow(
    'recovery'
  );
  const resumed = beginInitState(input);
  expect(resumed.resumed).toBe(true);
  expect(resumed.phase).toBe('create-attempted');
  mkdirSync(join(resumed.stage, 'store'));
  writeFileSync(join(resumed.stage, 'store', 'record'), 'data');
  resumed.publish(
    { server: input.server, repo: 'r', base: [] },
    prepareIgnore(input.root)
  );
  // Cleanup can be retried without unpublishing the working copy.
  resumed.finish();
  resumed.finish();
  expect(
    JSON.parse(
      readFileSync(join(input.root, '.thaddeus', 'config.json'), 'utf8')
    )
  ).toMatchObject({ repo: 'r', base: [] });
  expect(
    readFileSync(join(input.root, '.thaddeus', 'store', 'record'), 'utf8')
  ).toBe('data');
});

test('rollback keeps a store that changed after publication started', () => {
  const input = setup();
  const state = beginInitState(input);
  mkdirSync(join(state.stage, 'store'));
  writeFileSync(join(state.stage, 'store', 'record'), 'data');
  // Force failure at the config commit point after store installation.
  mkdirSync(join(input.root, '.thaddeus', 'config.json'));
  expect(() =>
    state.publish(
      { server: input.server, repo: 'r', base: [] },
      prepareIgnore(input.root)
    )
  ).toThrow();
  writeFileSync(join(input.root, '.thaddeus', 'store', 'record'), 'changed');
  expect(() => state.rollback()).toThrow('changed');
  state.release();
  expect(
    readFileSync(join(input.root, '.thaddeus', 'store', 'record'), 'utf8')
  ).toBe('changed');
});

test('a leftover journal after commit never rolls back a subsequently edited config', () => {
  const input = setup();
  const first = beginInitState(input);
  mkdirSync(join(first.stage, 'store'));
  writeFileSync(join(first.stage, 'store', 'record'), 'data');
  first.publish(
    { server: input.server, repo: 'r', base: [] },
    prepareIgnore(input.root)
  );
  first.release();
  writeFileSync(
    join(input.root, '.thaddeus', 'config.json'),
    JSON.stringify({ server: input.server, repo: 'r', base: ['new-head'] })
  );
  writeFileSync(join(input.root, '.thaddeus', 'store', 'record'), 'new-data');
  const recovered = beginInitState(input);
  recovered.finish();
  expect(
    readFileSync(join(input.root, '.thaddeus', 'store', 'record'), 'utf8')
  ).toBe('new-data');
  expect(
    readFileSync(join(input.root, '.thaddeus', 'config.json'), 'utf8')
  ).toContain('new-head');
});

test('a changed stage is preserved for inspection', () => {
  const input = setup();
  const state = beginInitState(input);
  const moved = state.stage + '-moved';
  // Replacing an owned directory must not transfer cleanup ownership.
  renameSync(state.stage, moved);
  mkdirSync(state.stage);
  writeFileSync(join(state.stage, 'keep'), 'user');
  expect(() => state.rollback()).toThrow('changed init stage');
  state.release();
  expect(readFileSync(join(state.stage, 'keep'), 'utf8')).toBe('user');
});

test('invalid recovery records are rejected without touching the source directory', () => {
  const input = setup();
  const record = initJournalPath(input.root, input.home);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(
    record,
    JSON.stringify({ version: 1, attempt: '../../outside' })
  );
  expect(() => beginInitState(input)).toThrow('recovery record');
  expect(readdirSync(input.root)).toEqual([]);
});

test('a killed process after store installation is recovered before publishing config', async () => {
  const input = setup();
  const script = `
    import { beginInitState } from ${JSON.stringify(join(import.meta.dir, '../src/init-state.ts'))};
    import { prepareIgnore } from ${JSON.stringify(join(import.meta.dir, '../src/ignore.ts'))};
    import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const input = ${JSON.stringify(input)};
    const state = beginInitState(input);
    state.mark('remote-created');
    mkdirSync(join(state.stage,'store'));
    writeFileSync(join(state.stage,'store','record'),'persisted');
    const config = join(input.root,'.thaddeus','config.json');
    mkdirSync(config);
    try { state.publish({server:input.server,repo:input.repo,base:[]},prepareIgnore(input.root)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    rmSync(config,{recursive:true});
    if (!existsSync(join(input.root,'.thaddeus','store','record'))) throw new Error('store not installed');
    console.log('store installed');
    await new Promise(() => {});
  `;
  const child = Bun.spawn(['bun', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    let output = '';
    while (!output.includes('store installed')) {
      const part = await reader.read();
      if (part.done)
        throw new Error(
          `child exited before store installation: ${await new Response(child.stderr).text()}`
        );
      output += new TextDecoder().decode(part.value);
    }
    child.kill('SIGKILL');
    await child.exited;
    expect(existsSync(join(input.root, '.thaddeus', 'store', 'record'))).toBe(
      true
    );
    const recovered = beginInitState(input);
    expect(recovered.phase).toBe('remote-created');
    expect(existsSync(join(input.root, '.thaddeus', 'store'))).toBe(false);
    expect(existsSync(join(input.root, '.thaddeus', 'config.json'))).toBe(
      false
    );
    recovered.rollback();
    recovered.finish();
    expect(readdirSync(input.root)).toEqual([]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
}, 15_000);
