const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: {
      // Native modules and ExifTool binary must be outside the asar archive
      // to be executable at runtime. The auto-unpack-natives plugin handles
      // better-sqlite3; we add exiftool-vendored explicitly.
      unpack: '{**/node_modules/better-sqlite3/**,**/node_modules/exiftool-vendored*/**}',
    },
    name:           'Fissick',
    executableName: 'Fissick',
    // Icon: assets/icon.icns on Mac, assets/icon.ico on Windows
    // Run: iconutil -c icns assets/icon.iconset -o assets/icon.icns
    // Then add assets/icon.ico for Windows before building on that platform.
    icon: 'assets/icon',

    // macOS: ignore dev-only files from the app bundle
    ignore: [
      /^\/\.git/,
      /^\/tests/,
      /^\/assets\/icon\.iconset/,
      /^\/fake-takeout/,
      /^\/scripts/,
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
        format: 'UDZO',           // zlib compression, universally compatible
        name:   'Fissick',
      },
    },
    // Windows — only runs on Windows
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name:            'Fissick',
        setupExe:        'FissickSetup.exe',
        setupIcon:       'assets/icon.ico',
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
    // Automatically rebuilds native modules (better-sqlite3) against
    // the packaged Electron Node.js version
    {
      name:   '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },

    // Security fuses — conservative set for unsigned distribution
    // EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar require
    // code signing. Enable them after getting an Apple Developer certificate.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]:                          false,
      [FuseV1Options.EnableCookieEncryption]:             true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]:      false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false, // needs code signing
      [FuseV1Options.OnlyLoadAppFromAsar]:                false, // needs code signing
    }),
  ],
};
