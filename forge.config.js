const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: {
      // Native modules and binaries that must be executable at runtime cannot
      // live inside the asar archive. List them here explicitly.
      //
      // better-sqlite3      — native .node addon
      // exiftool-vendored*  — covers both exiftool-vendored (JS) and
      //                       exiftool-vendored.pl (the Perl binary package)
      // ffmpeg-static       — exports a filesystem path to the ffmpeg binary;
      //                       execFile() cannot target a path inside an asar
      // sharp               — native .node addon (libvips);
      //                       also caught by plugin-auto-unpack-natives below,
      //                       but being explicit avoids any detection edge cases
      unpack: '{**/node_modules/better-sqlite3/**,**/node_modules/exiftool-vendored*/**,**/node_modules/ffmpeg-static/**,**/node_modules/sharp/**}',
    },

    name:           'Fissick',
    executableName: 'Fissick',
    appBundleId:    'app.fissick.desktop',

    // macOS icon — run `npm run build:icon` once before building to produce this
    icon: 'assets/icon',

    // Files to exclude from the packaged app bundle
    ignore: [
      /^\/\.git/,
      /^\/tests/,
      /^\/playwright-report/,
      /^\/out/,
      /^\/assets\/icon\.iconset/,
      /^\/fake-takeout/,
      /^\/scripts/,
      /^\/fossick_devplan\.html/,
      /node_modules\/\.cache/,
    ],
  },

  rebuildConfig: {},

  makers: [
    // macOS — only runs on macOS
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'UDZO',      // zlib compression, universally compatible
        name:   'Fissick',
      },
    },

    // Windows — only runs on Windows
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name:        'Fissick',
        setupExe:    'FissickSetup.exe',
        setupIcon:   'assets/icon.ico',
        authors:     'Alex Druk',
        description: 'Fix Google Takeout photo metadata',
        // Add certificateFile + certificatePassword here when you have a cert
      },
    },

    // Linux / CI fallback
    {
      name:      '@electron-forge/maker-zip',
      platforms: ['linux'],
    },
  ],

  plugins: [
    // Automatically unpacks native .node addons from the asar so they can
    // be loaded by Node.js at runtime (supplements the explicit unpack list above)
    {
      name:   '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },

    // Security fuses — conservative set for unsigned distribution.
    // EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar require
    // code signing. Enable them after getting an Apple Developer certificate.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]:                             false,
      [FuseV1Options.EnableCookieEncryption]:                true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:  false,
      [FuseV1Options.EnableNodeCliInspectArguments]:         false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false, // needs code signing
      [FuseV1Options.OnlyLoadAppFromAsar]:                   false, // needs code signing
    }),
  ],
};
