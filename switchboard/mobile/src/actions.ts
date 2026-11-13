import { Linking, Platform } from 'react-native'
import * as Battery from 'expo-battery'
import * as Calendar from 'expo-calendar'
import * as Clipboard from 'expo-clipboard'
import * as Device from 'expo-device'
import * as Haptics from 'expo-haptics'
import * as Location from 'expo-location'
import * as MailComposer from 'expo-mail-composer'
import * as Notifications from 'expo-notifications'
import * as SMS from 'expo-sms'
import Constants from 'expo-constants'
import type { AppSettings } from './config'
import { speak, stopSpeaking } from './voice'

/** What this phone can do when a session asks (the `phone` tool). */
export const CAPABILITIES = [
  'speak',
  'stop_speaking',
  'notify',
  'vibrate',
  'open_url',
  'get_location',
  'get_battery',
  'get_device_info',
  'clipboard_get',
  'clipboard_set',
  'calendar_list',
  'calendar_create',
  'compose_sms',
  'compose_email',
]

type Params = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

export async function runAction(action: string, p: Params, settings: AppSettings): Promise<unknown> {
  switch (action) {
    case 'speak':
      await speak(str(p.text), settings)
      return 'Spoken.'
    case 'stop_speaking':
      stopSpeaking()
      return 'Stopped.'
    case 'notify':
      await Notifications.scheduleNotificationAsync({
        content: { title: str(p.title) || 'Claude', body: str(p.body ?? p.text), sound: 'default' },
        trigger: null,
      })
      return 'Notification shown.'
    case 'vibrate': {
      const pattern = str(p.pattern)
      if (pattern === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      else if (pattern === 'warning') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      else await Haptics.impactAsync(pattern === 'long' ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium)
      return 'Vibrated.'
    }
    case 'open_url': {
      const url = str(p.url)
      if (!url) throw new Error('url is required')
      if (!(await Linking.canOpenURL(url).catch(() => false)) && !/^https?:/i.test(url)) throw new Error(`No app on this phone opens ${url}`)
      await Linking.openURL(url)
      return 'Opened.'
    }
    case 'get_location': {
      if (!settings.allowLocation) throw new Error('Location sharing is off. The user can turn it on in Switchboard > Settings.')
      const perm = await Location.requestForegroundPermissionsAsync()
      if (perm.status !== 'granted') throw new Error('Location permission was not granted')
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      const [place] = await Location.reverseGeocodeAsync(pos.coords).catch(() => [])
      return {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy_m: Math.round(pos.coords.accuracy ?? 0),
        address: place ? [place.name, place.street, place.city, place.region, place.postalCode, place.country].filter(Boolean).join(', ') : null,
      }
    }
    case 'get_battery': {
      const [level, state, lowPower] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync(), Battery.isLowPowerModeEnabledAsync()])
      return {
        level: `${Math.round(level * 100)}%`,
        charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
        low_power_mode: lowPower,
      }
    }
    case 'get_device_info':
      return {
        model: Device.modelName,
        os: `${Device.osName} ${Device.osVersion}`,
        app_version: Constants.expoConfig?.version,
        platform: Platform.OS,
      }
    case 'clipboard_get':
      if (!settings.allowClipboard) throw new Error('Clipboard access is off. The user can turn it on in Switchboard > Settings.')
      return await Clipboard.getStringAsync()
    case 'clipboard_set':
      await Clipboard.setStringAsync(str(p.text))
      return 'Copied to the clipboard.'
    case 'calendar_list': {
      if (!settings.allowCalendar) throw new Error('Calendar access is off. The user can turn it on in Switchboard > Settings.')
      await calendarPermission()
      const days = Math.min(Math.max(Number(p.days) || 3, 1), 31)
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const start = new Date()
      const end = new Date(Date.now() + days * 86400000)
      const events = await Calendar.getEventsAsync(
        calendars.map(c => c.id),
        start,
        end,
      )
      return events
        .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
        .slice(0, 50)
        .map(e => ({ title: e.title, start: e.startDate, end: e.endDate, location: e.location || undefined, all_day: e.allDay || undefined }))
    }
    case 'calendar_create': {
      if (!settings.allowCalendar) throw new Error('Calendar access is off. The user can turn it on in Switchboard > Settings.')
      await calendarPermission()
      const title = str(p.title)
      const start = new Date(str(p.start))
      if (!title || Number.isNaN(start.getTime())) throw new Error('title and an ISO start time are required')
      const end = p.end ? new Date(str(p.end)) : new Date(start.getTime() + 30 * 60000)
      const calendarId = await writableCalendar()
      const id = await Calendar.createEventAsync(calendarId, {
        title,
        startDate: start,
        endDate: end,
        notes: str(p.notes) || undefined,
        location: str(p.location) || undefined,
      })
      return { created: id }
    }
    case 'compose_sms': {
      if (!(await SMS.isAvailableAsync())) throw new Error('This phone cannot send texts')
      const to = Array.isArray(p.to) ? p.to.map(String) : p.to ? [str(p.to)] : []
      const r = await SMS.sendSMSAsync(to, str(p.body))
      return `Draft ${r.result}.`
    }
    case 'compose_email': {
      if (!(await MailComposer.isAvailableAsync())) throw new Error('No mail app is set up on this phone')
      const r = await MailComposer.composeAsync({
        recipients: Array.isArray(p.to) ? p.to.map(String) : p.to ? [str(p.to)] : [],
        subject: str(p.subject),
        body: str(p.body),
      })
      return `Draft ${r.status}.`
    }
  }
  throw new Error(`This phone does not know "${action}"`)
}

async function calendarPermission() {
  const perm = await Calendar.requestCalendarPermissionsAsync()
  if (perm.status !== 'granted') throw new Error('Calendar permission was not granted')
}

async function writableCalendar(): Promise<string> {
  if (Platform.OS === 'ios') {
    const def = await Calendar.getDefaultCalendarAsync()
    return def.id
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
  const primary = calendars.find(c => c.isPrimary && c.allowsModifications) ?? calendars.find(c => c.allowsModifications)
  if (!primary) throw new Error('No calendar on this phone accepts new events')
  return primary.id
}
