import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function getSnapshot() {
  return window.location.pathname;
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(to: string) {
  if (to !== window.location.pathname) {
    window.history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
