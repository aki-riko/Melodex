import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const repositoryRoot = resolve(frontendRoot, '..');

const removedPaths = [
  'src/App.css',
  'src/logo.svg',
  'src/components/ArtistCard.js',
  'src/components/ArtistModal.js',
  'src/components/FAQ.js',
  'src/components/Footer.js',
  'src/components/Hero.js',
  'src/components/Navbar.js',
  'src/components/TrackCard.js',
  'src/components/TrackModal.js',
  'src/components/TrackTable.js',
  'src/components/Trending.js',
  'src/services/lastfm.js',
  'src/services/spotify.js',
  'src/utils/format.js',
  'public/favicon.ico',
  'public/images/disc.png',
  'public/sounds/scratch.mp3',
  '.github/banner.gif',
  '.github/banner.png',
];

const textExtensions = new Set(['.css', '.html', '.js', '.jsx', '.md']);
const textFiles = [
  resolve(repositoryRoot, 'README.md'),
  resolve(repositoryRoot, 'AGENTS.md'),
  resolve(frontendRoot, '.env.example'),
  resolve(frontendRoot, 'index.html'),
  resolve(frontendRoot, 'package.json'),
  resolve(frontendRoot, 'README.md'),
  resolve(frontendRoot, 'THIRD-PARTY-LICENSES.md'),
  resolve(frontendRoot, 'vite.config.js'),
];

function collectSourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolutePath);
    } else if (textExtensions.has(extname(entry.name))) {
      textFiles.push(absolutePath);
    }
  }
}

collectSourceFiles(resolve(frontendRoot, 'src'));
collectSourceFiles(resolve(frontendRoot, 'public'));

const forbiddenText = [
  new RegExp(['tune', 'scout'].join(''), 'i'),
  new RegExp(['peter', '-bf'].join(''), 'i'),
  new RegExp(['last', '\\.', 'fm'].join(''), 'i'),
  new RegExp(['VITE', '_LASTFM_API_KEY'].join(''), 'i'),
];
const failures = [];

for (const path of removedPaths) {
  if (existsSync(resolve(frontendRoot, path))) {
    failures.push(`removed path still exists: ${path}`);
  }
}

for (const path of textFiles) {
  const content = readFileSync(path, 'utf8');
  for (const pattern of forbiddenText) {
    if (pattern.test(content)) {
      failures.push(`forbidden source marker in ${relative(repositoryRoot, path)}: ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Frontend source boundary is clean.');
}
