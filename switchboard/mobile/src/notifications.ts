import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'

// While the app is open, show nothing extra: the screen already has it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
})

/** Notification categories: reply from the lock screen, approve or deny a tool. */
export async function setupNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages from sessions',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 120, 80, 120],
    })
  }
  await Notifications.setNotificationCategoryAsync('message', [
    {
      identifier: 'reply',
      buttonTitle: 'Reply',
      textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
      options: { opensAppToForeground: false },
    },
  ])
  await Notifications.setNotificationCategoryAsync('permission', [
    { identifier: 'allow', buttonTitle: 'Allow', options: { opensAppToForeground: true, isAuthenticationRequired: true } },
    { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: true, isDestructive: true } },
  ])
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync()
  if (current.granted) return true
  const asked = await Notifications.requestPermissionsAsync()
  return asked.granted
}

/** The Expo push token, when this build has an EAS project id (push needs one). */
export async function pushToken(): Promise<string | null> {
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
  if (!projectId) return null
  try {
    if (!(await requestNotificationPermission())) return null
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data
  } catch {
    return null
  }
}

export async function localNotification(title: string, body: string, data: Record<string, unknown>, categoryIdentifier?: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data, sound: 'default', ...(categoryIdentifier ? { categoryIdentifier } : {}) },
    trigger: null,
  })
}
