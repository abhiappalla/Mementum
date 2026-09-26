import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

let _granted: boolean | null = null;

export async function checkNotificationPermission(): Promise<boolean> {
  if (_granted !== null) return _granted;
  _granted = await isPermissionGranted();
  return _granted;
}

export async function requestNotificationPermission(): Promise<boolean> {
  const perm = await requestPermission();
  _granted = perm === 'granted';
  return _granted;
}

export async function notify(title: string, body: string): Promise<void> {
  if (_granted === null) _granted = await isPermissionGranted();
  if (!_granted) return;
  sendNotification({ title, body });
}
