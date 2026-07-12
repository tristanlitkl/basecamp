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
      const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      const progress = Math.min(Math.max(window.scrollY / max, 0), 1);
      document.documentElement.style.setProperty("--adventure-progress", progress.toFixed(4));
      document.documentElement.style.setProperty("--adventure-scroll", `${progress * 42}px`);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--adventure-scroll");
      document.documentElement.style.removeProperty("--adventure-progress");
    };
  }, []);

  return <div aria-hidden="true" className="adventure-background"><i className="adventure-aurora" /><i className="adventure-contours" /><i className="adventure-route" /></div>;
}
