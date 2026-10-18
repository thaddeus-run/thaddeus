import { version } from '../../../../packages/cli/package.json';

// Site-wide copy and links. Marketing text lives here rather than inline in
// components so wording can change without touching layout.

export const site = {
  version: `v${version}`,
  // thaddeus.run/install.sh redirects to the raw install script on main; the
  // rule lives in vercel.json.
  installCommand: 'curl -fsSL https://thaddeus.run/install.sh | sh',
  contactEmail: 'moritz@thaddeus.run',
  links: {
    docs: 'https://github.com/thaddeus-run/thaddeus/blob/main/docs/getting-started.md',
    github: 'https://github.com/thaddeus-run/thaddeus',
    changelog:
      'https://github.com/thaddeus-run/thaddeus/blob/main/CHANGELOG.md',
    email: 'mailto:moritz@thaddeus.run',
    status: 'https://status.thaddeus.run',
  },
} as const;
