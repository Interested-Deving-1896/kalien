import { useSyncExternalStore } from "react";
import { RELATIVE_TIME_REFRESH_MS } from "@/consts";

let tick = 0;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    intervalId = setInterval(() => {
      tick++;
      listeners.forEach((fn) => fn());
    }, RELATIVE_TIME_REFRESH_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot() {
  return tick;
}

/** Forces a re-render every 15s. A single shared timer is used no matter how many components subscribe. */
export function useTick(): void {
  useSyncExternalStore(subscribe, getSnapshot);
}
