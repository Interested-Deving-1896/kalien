import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function notifyLocationChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    window.addEventListener("popstate", notifyLocationChange);
  }

  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.removeEventListener("popstate", notifyLocationChange);
    }
  };
}

function getSnapshot() {
  return window.location.pathname;
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(to: string) {
  if (to !== window.location.pathname + window.location.search) {
    window.history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
