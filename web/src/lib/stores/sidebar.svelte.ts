import { browser } from '$app/environment';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

const STORAGE_KEY = 'immich-sidebar-open';

const readInitialOpen = (): boolean => {
  if (!browser) {
    return true;
  }
  const value = localStorage.getItem(STORAGE_KEY);
  if (value === 'false') {
    return false;
  }
  return true;
};

class SidebarStore {
  isOpen = $state(readInitialOpen());

  /**
   * Reset the sidebar visibility to the default, based on the current screen width.
   * Used by click-outside/escape handlers on mobile overlays.
   */
  reset() {
    this.isOpen = mediaQueryManager.isFullSidebar;
  }

  /**
   * Toggles the sidebar visibility and persists the preference.
   */
  toggle() {
    this.isOpen = !this.isOpen;
    if (browser) {
      localStorage.setItem(STORAGE_KEY, String(this.isOpen));
    }
  }
}

export const sidebarStore = new SidebarStore();
