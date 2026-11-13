import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * Build-time settings come from the environment (or eas.json profiles):
 *   SWITCHBOARD_PUBLIC_URL   the hub address the phone can reach, e.g. https://mac.tailnet.ts.net
 *                            Over-the-air updates are fetched from <url>/updates/manifest.
 *   SWITCHBOARD_IOS_BUNDLE_ID / SWITCHBOARD_ANDROID_PACKAGE   your own identifiers
 *   EAS_PROJECT_ID           set by `eas init`; needed only for push notifications
 *
 * runtimeVersion: bump it whenever a change needs a new native build (a new
 * native module, a permission, an SDK upgrade). JavaScript-only changes keep it,
 * and phones on the same runtime update themselves over the air.
 */
const RUNTIME_VERSION = '1'

export default ({ config }: ConfigContext): ExpoConfig => {
  const hub = (process.env.SWITCHBOARD_PUBLIC_URL || '').replace(/\/+$/, '')
  const bundleId = process.env.SWITCHBOARD_IOS_BUNDLE_ID || 'dev.switchboard.app'
  const androidPackage = process.env.SWITCHBOARD_ANDROID_PACKAGE || 'dev.switchboard.app'
  return {
    ...config,
    name: 'Switchboard',
    slug: 'switchboard',
    scheme: 'switchboard',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    runtimeVersion: RUNTIME_VERSION,
    updates: {
      enabled: Boolean(hub),
      url: hub ? `${hub}/updates/manifest` : undefined,
      // Start right away on what is installed; a new update downloads in the
      // background and the app switches to it when it is not in the middle of talking.
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: true,
      infoPlist: {
        UIBackgroundModes: ['audio', 'remote-notification'],
        NSMicrophoneUsageDescription: 'Switchboard records what you say to send it to your Claude Code sessions.',
        NSSpeechRecognitionUsageDescription: 'Switchboard can turn what you say into text on this phone.',
        NSLocationWhenInUseUsageDescription: 'A Claude Code session can ask where you are, if you allow it in Settings.',
        NSCalendarsUsageDescription: 'A Claude Code session can read and add calendar events, if you allow it in Settings.',
        NSCalendarsFullAccessUsageDescription: 'A Claude Code session can read and add calendar events, if you allow it in Settings.',
        NSCameraUsageDescription: 'Scan the pairing code shown by your Switchboard hub.',
        // The hub is often reached over plain http on a private network (Tailscale, home Wi-Fi).
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: androidPackage,
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#111318' },
      permissions: [
        'RECORD_AUDIO',
        'POST_NOTIFICATIONS',
        'VIBRATE',
        'WAKE_LOCK',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
        'READ_CALENDAR',
        'WRITE_CALENDAR',
        'CAMERA',
        // Installs a new build of this app that the hub offers (Settings > App updates).
        'REQUEST_INSTALL_PACKAGES',
      ],
    },
    plugins: [
      [
        'expo-audio',
        {
          microphonePermission: 'Switchboard records what you say to send it to your Claude Code sessions.',
          enableBackgroundPlayback: true,
          enableBackgroundRecording: true,
        },
      ],
      [
        'expo-speech-recognition',
        {
          microphonePermission: 'Switchboard records what you say to send it to your Claude Code sessions.',
          speechRecognitionPermission: 'Switchboard can turn what you say into text on this phone.',
        },
      ],
      ['expo-notifications', { color: '#7c9cff' }],
      ['expo-camera', { cameraPermission: 'Scan the pairing code shown by your Switchboard hub.' }],
      ['expo-location', { locationWhenInUsePermission: 'A Claude Code session can ask where you are, if you allow it in Settings.' }],
      ['expo-calendar', { calendarPermission: 'A Claude Code session can read and add calendar events, if you allow it in Settings.' }],
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
      'expo-secure-store',
    ],
    extra: {
      hubUrl: hub || null,
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
  }
}
