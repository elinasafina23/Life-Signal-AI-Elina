"use client";

import { useEffect, useRef, useState } from "react";

type BindProps = React.HTMLAttributes<HTMLElement>;

export function useSosDialer(opts?: {
  phoneNumber?: string;
  contactName?: string;
  holdToActivateMs?: number;
  confirm?: boolean;
}) {
  const {
    phoneNumber = "+78473454308",
    contactName = "Emergency Contact",
    holdToActivateMs = 1500,
    confirm = true,
  } = opts || {};

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  // drive progress (for rings/animations if you want)
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      if (holding) {
        const elapsed = Date.now() - startedAtRef.current;
        setProgress(Math.min(1, elapsed / holdToActivateMs));
        rafId = requestAnimationFrame(tick);
      }
    };
    if (holding) rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [holding, holdToActivateMs]);

  const completeActivation = () => {
    // optional confirm
    const label = contactName ? ` ${contactName}` : "";
    if (!confirm || window.confirm(`Call${label}?`)) {
      const a = document.createElement("a");
      a.href = `tel:${phoneNumber.replace(/\s+/g, "")}`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  const beginHold = () => {
    if (holding) return;
    setHolding(true);
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(completeActivation, holdToActivateMs);
  };

  const cancelHold = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHolding(false);
    setProgress(0);
  };

  // handlers you can spread onto ANY clickable element (button/div/etc.)
  const bind: BindProps = {
    role: "button",
    tabIndex: 0,
    "aria-label": `Call ${contactName}`,
    onMouseDown: beginHold,
    onMouseUp: cancelHold,
    onMouseLeave: cancelHold,
    onTouchStart: (e) => {
      e.preventDefault();
      beginHold();
    },
    onTouchEnd: cancelHold,
    onKeyDown: (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        beginHold();
      }
    },
    onKeyUp: (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        cancelHold();
      }
    },
  };

  return { bind, holding, progress, cancelHold };
}
