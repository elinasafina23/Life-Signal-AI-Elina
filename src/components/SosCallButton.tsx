"use client";

import React, { useRef, useState, useEffect } from "react";

/**
 * Press-and-hold SOS button that dials via tel: link (no framer-motion).
 * Works in a PWA; the OS will open the dialer on mobile.
 */
export default function SosCallButton({
  phoneNumber = process.env.NEXT_PUBLIC_SOS_NUMBER ?? "+78473454308",
  contactName = "Emergency Contact",
  holdToActivateMs = 1500,
  confirm = true,
  className = "",
}: {
  phoneNumber?: string;          // pass a number or set NEXT_PUBLIC_SOS_NUMBER
  contactName?: string;
  holdToActivateMs?: number;
  confirm?: boolean;
  className?: string;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let rafId = 0 as number | undefined;
    const tick = () => {
      if (holding) {
        const elapsed = Date.now() - startedAtRef.current;
        setProgress(Math.min(1, elapsed / holdToActivateMs));
        rafId = requestAnimationFrame(tick);
      }
    };
    if (holding) rafId = requestAnimationFrame(tick);
    return () => (rafId ? cancelAnimationFrame(rafId) : undefined);
  }, [holding, holdToActivateMs]);

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

  const completeActivation = () => {
    cancelHold();
    const cleaned = (phoneNumber || "").replace(/\s+/g, "");
    if (!cleaned) return;
    const label = contactName ? ` ${contactName}` : "";
    if (!confirm || window.confirm(`Call${label}?`)) {
      const a = document.createElement("a");
      a.href = `tel:${cleaned}`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      beginHold();
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      cancelHold();
    }
  };

  const ringStyle: React.CSSProperties = {
    background: `conic-gradient(currentColor ${progress * 360}deg, rgba(0,0,0,0.08) 0deg)`,
  };

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-red-600 mb-3">Emergency SOS</h2>
        <p className="text-sm text-gray-500 mb-5">Press & hold to call {contactName}.</p>

        <button
          type="button"
          aria-label={`Call ${contactName}`}
          onMouseDown={beginHold}
          onMouseUp={cancelHold}
          onMouseLeave={cancelHold}
          onTouchStart={(e) => {
            e.preventDefault();
            beginHold();
          }}
          onTouchEnd={cancelHold}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          className="relative outline-none active:scale-95 transition-transform"
        >
          <div
            aria-hidden
            className="grid place-items-center w-44 h-44 rounded-full text-red-500 transition-colors"
            style={ringStyle}
          >
            <div
              className={`grid place-items-center w-36 h-36 rounded-full shadow-xl select-none transition-colors ${
                holding ? "bg-red-600" : "bg-red-500"
              }`}
            >
              {/* phone icon (feather-style) */}
              <svg
                width="36"
                height="36"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M10.29 3.86L1.82 12.34a2 2 0 0 0 0 2.83l7.06 7.06a2 2 0 0 0 2.83 0l8.47-8.47a2 2 0 0 0 0-2.83L13.12 1a2 2 0 0 0-2.83 0" />
              </svg>
            </div>
          </div>

          <span className="sr-only" aria-live="polite">
            {holding ? Math.round(progress * 100) + "%" : "Idle"}
          </span>
        </button>

        <p className="mt-3 text-xs text-gray-400">
          Hold for {Math.round(holdToActivateMs / 1000)}s to confirm. Releasing cancels.
        </p>
      </div>
    </div>
  );
}
