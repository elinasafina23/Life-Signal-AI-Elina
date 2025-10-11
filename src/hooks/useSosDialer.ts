// src/hooks/useSosDialer.ts
"use client";

import { useEffect, useRef, useState } from "react";

type BindProps = React.HTMLAttributes<HTMLElement>;

export function useSosDialer(opts?: {
  phoneNumber?: string;
  contactName?: string;
  /** Hold duration in ms before release will dial */
  holdToActivateMs?: number;
  confirm?: boolean;
  onActivate?: () => void | Promise<void>;
}) {
  const {
    phoneNumber = "+18473454308",
    contactName = "Emergency Contact",
    holdToActivateMs = 1500,
    confirm = true,
    onActivate,
  } = opts || {};

  const startedAtRef = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [ready, setReady] = useState(false);

  // Drive progress (for rings/animations)
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      if (holding && startedAtRef.current != null) {
        const elapsed = Date.now() - startedAtRef.current;
        const p = Math.min(1, elapsed / holdToActivateMs);
        setProgress(p);
        setReady(p >= 1);
        rafId = requestAnimationFrame(tick);
      }
    };
    if (holding) rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [holding, holdToActivateMs]);

  const dialNow = async () => {
    const label = contactName ? ` ${contactName}` : "";
    if (confirm && !window.confirm(`Call${label}?`)) return;

    try {
      if (onActivate) await onActivate();
    } catch (err) {
      console.error("useSosDialer onActivate failed", err);
      // continue dialing regardless
    }

    const telHref = `tel:${phoneNumber.replace(/\s+/g, "")}`;

    try {
      // Most reliable when executed within the same user gesture
      window.location.href = telHref;
    } catch {
      // Fallback: programmatic <a> click with delayed removal
      const a = document.createElement("a");
      a.href = telHref;
      a.style.position = "fixed";
      a.style.left = "-9999px";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 500);
    }
  };

  const beginHold = () => {
    if (holding) return;
    setHolding(true);
    setProgress(0);
    setReady(false);
    startedAtRef.current = Date.now();
  };

  const endHold = () => {
    if (!holding) return;
    setHolding(false);

    const started = startedAtRef.current;
    startedAtRef.current = null;

    const elapsed = started ? Date.now() - started : 0;
    const passed = elapsed >= holdToActivateMs;

    // reset visuals
    setProgress(0);
    setReady(false);

    // IMPORTANT: Dial in the *release* event (same user gesture)
    if (passed) {
      void dialNow();
    }
  };

  const cancelHold = () => {
    if (!holding) return;
    setHolding(false);
    startedAtRef.current = null;
    setProgress(0);
    setReady(false);
  };

  // Handlers you can spread onto ANY clickable element
  const bind: BindProps = {
    role: "button",
    tabIndex: 0,
    "aria-label": `Call ${contactName}`,
    // Pointer covers mouse + touch + pen
    onPointerDown: beginHold,
    onPointerUp: endHold,
    onPointerLeave: cancelHold,
    // Touch-specific: prevent synthetic click to avoid double firing
    onTouchStart: (e) => {
      e.preventDefault();
      beginHold();
    },
    onTouchEnd: endHold,
    // Keyboard support
    onKeyDown: (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        beginHold();
      }
    },
    onKeyUp: (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        endHold();
      }
    },
  };

  return { bind, holding, progress, ready, cancelHold };
}
