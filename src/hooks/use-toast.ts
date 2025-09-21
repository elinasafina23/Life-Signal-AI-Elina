// src/hooks/use-toast.ts
"use client";

import * as React from "react";
import type { ToastActionElement, ToastProps } from "@/components/ui/toast";

/** Max number of toasts visible at once. */
const TOAST_LIMIT = 1;
/** How long to keep a toast in the DOM after it’s dismissed (ms). */
const TOAST_REMOVE_DELAY = 1_000_000;

/** Our internal toast shape (adds an id to the UI props). */
type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

/** Action type constants (so TS can infer discriminated unions nicely). */
const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const;

type ActionType = typeof actionTypes;

/** All possible actions our reducer can handle. */
type Action =
  | { type: ActionType["ADD_TOAST"]; toast: ToasterToast }
  | { type: ActionType["UPDATE_TOAST"]; toast: Partial<ToasterToast> }
  | { type: ActionType["DISMISS_TOAST"]; toastId?: ToasterToast["id"] }
  | { type: ActionType["REMOVE_TOAST"]; toastId?: ToasterToast["id"] };

/** Our tiny state shape: just an array of toasts. */
interface State {
  toasts: ToasterToast[];
}

/** Simple id generator for toasts. */
let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

/** Track scheduled removals so we don’t double-schedule timers. */
const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedule a toast to be hard-removed after a delay (post-dismiss). */
const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) return;

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({ type: "REMOVE_TOAST", toastId });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

/** Cancel a scheduled removal timer for a toast (or all). */
const clearFromRemoveQueue = (toastId?: string) => {
  if (toastId) {
    const t = toastTimeouts.get(toastId);
    if (t) {
      clearTimeout(t);
      toastTimeouts.delete(toastId);
    }
    return;
  }
  // Clear all
  for (const t of toastTimeouts.values()) clearTimeout(t);
  toastTimeouts.clear();
};

/** Pure-ish reducer (we keep one small side-effect in DISMISS for brevity). */
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case "DISMISS_TOAST": {
      const { toastId } = action;

      // Side effect: queue removal after the animation/timeout
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((t) => addToRemoveQueue(t.id));
      }

      // Mark it closed so the UI can animate out
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined ? { ...t, open: false } : t
        ),
      };
    }

    case "REMOVE_TOAST": {
      // Side effect: ensure timer is cleared for removed toast(s)
      if (action.toastId) {
        clearFromRemoveQueue(action.toastId);
        return { ...state, toasts: state.toasts.filter((t) => t.id !== action.toastId) };
      }
      // Remove all
      clearFromRemoveQueue();
      return { ...state, toasts: [] };
    }
  }
};

/** Simple global store (listeners + in-memory state). */
const listeners: Array<(state: State) => void> = [];
let memoryState: State = { toasts: [] };

/** Broadcast state updates to all subscribers. */
function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

/** Public toast input shape (same as ToasterToast but without id). */
type Toast = Omit<ToasterToast, "id">;

/** Main toast creator API. */
function toast({ ...props }: Toast) {
  const id = genId();

  const update = (next: ToasterToast) =>
    dispatch({ type: "UPDATE_TOAST", toast: { ...next, id } });

  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return { id, dismiss, update };
}

/** Hook used by your Toaster UI to get current toasts + helpers. */
function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  // Register once on mount; unregister on unmount.
  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const i = listeners.indexOf(setState);
      if (i > -1) listeners.splice(i, 1);
    };
  }, []); // <-- important: run once

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToast, toast };
