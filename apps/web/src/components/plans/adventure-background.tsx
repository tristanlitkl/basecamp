"use client";

import React, { useEffect } from "react";

/** A deliberately tiny, paint-only parallax signal for the decorative page layers. */
export function AdventureBackground() {
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (reduced?.matches || !window.requestAnimationFrame) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      document.documentElement.style.setProperty("--adventure-scroll", `${Math.min(window.scrollY * 0.035, 42)}px`);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--adventure-scroll");
    };
  }, []);

  return <div aria-hidden="true" className="adventure-background"><i className="adventure-aurora" /><i className="adventure-contours" /><i className="adventure-route" /></div>;
}
