/**
 * Intercepts @immich/ui toastManager to route all notifications
 * through our custom notification bar.
 *
 * This module patches the ToastManager prototype at import time,
 * BEFORE any component code runs.
 */
import { notificationBar } from '$lib/stores/notification-bar.svelte';
import { toastManager } from '@immich/ui';

type NotificationType = 'success' | 'info' | 'warning' | 'danger';

const typeMap: Record<string, NotificationType> = {
  success: 'success',
  primary: 'success',
  info: 'info',
  warning: 'warning',
  danger: 'danger',
};

const timeoutByType: Record<string, number> = {
  success: 3000,
  info: 3000,
  warning: 5000,
  danger: 6000,
};

// Hide the original toast panel via CSS class
toastManager.setOptions({ class: 'immich-toast-hidden' });

// Patch the prototype's `open` method — the single gateway for ALL toasts
const proto = Object.getPrototypeOf(toastManager);
proto.open = function (item: unknown, options?: Record<string, unknown>) {
  const isCustom = !!(item as Record<string, unknown>)?.component;

  if (isCustom) {
    const props = (item as { props: Record<string, unknown> }).props;
    const type = typeMap[props.color as string] || 'success';
    const message = String(props.description || props.title || '');
    const button = props.button as { text: string; onClick: () => void } | undefined;
    const timeout = (options?.timeout as number) ?? timeoutByType[type] ?? 5000;
    if (button) {
      notificationBar.showWithAction(message, { label: button.text, onClick: button.onClick }, type, timeout);
    } else {
      notificationBar.show(message, type, timeout);
    }
  } else {
    const data = item as Record<string, unknown> | undefined;
    const color = (data?.color as string) || (options?.color as string) || 'success';
    const type = typeMap[color] || 'success';
    const message = String(data?.description || data?.title || '');
    const timeout = (options?.timeout as number) ?? timeoutByType[type] ?? 3000;
    notificationBar.show(message, type, timeout);
  }
};

// Prevent the original panel from ever mounting
proto.mount = async function () {};
