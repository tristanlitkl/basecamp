"use client";

import React, { useEffect } from "react";

type Rgb = readonly [number, number, number];

const palette: readonly Rgb[] = [
  [232, 241, 255], // pale cobalt
  [223, 246, 255], // cyan / blue-violet
  [241, 236, 255] // violet with a restrained emerald counterpart
];

const accentPalette: readonly Rgb[] = [
  [225, 246, 255],
  [231, 235, 255],
  [229, 248, 241]
];

function interpolateColor(stops: readonly Rgb[], progress: number) {
  const segment = Math.min(Math.floor(progress * (stops.length - 1)), stops.length - 2);
  const localProgress = progress * (stops.length - 1) - segment;
  const from = stops[segment];
  const to = stops[segment + 1];
  return `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * localProgress)).join(" ")})`;
}

/** A shared, idle-free scroll signal for the fixed decorative page layers. */
export function AdventureBackground() {
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (reduced?.matches || !window.requestAnimationFrame) return;

    const root = document.documentElement;
    let frame = 0;
    let maxScroll = 1;

    const measure = () => {
      maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    };

    const update = () => {
      frame = 0;
      const progress = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
      root.style.setProperty("--scroll-progress", progress.toFixed(3));
      root.style.setProperty("--bg-shift-x", `${Math.round(-48 + progress * 96)}px`);
      root.style.setProperty("--bg-shift-y", `${Math.round(-36 + progress * 72)}px`);
      root.style.setProperty("--bg-scale", (0.97 + progress * 0.12).toFixed(3));
      root.style.setProperty("--bg-rotation", `${(-4 + progress * 8).toFixed(2)}deg`);
      root.style.setProperty("--aurora-opacity", (0.16 + progress * 0.1).toFixed(3));
      root.style.setProperty("--bg-primary", interpolateColor(palette, progress));
      root.style.setProperty("--bg-accent", interpolateColor(accentPalette, progress));
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const onResize = () => { measure(); onScroll(); };

    measure();
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (frame) window.cancelAnimationFrame(frame);
      ["--scroll-progress", "--bg-shift-x", "--bg-shift-y", "--bg-scale", "--bg-rotation", "--aurora-opacity", "--bg-primary", "--bg-accent"].forEach((property) => root.style.removeProperty(property));
    };
  }, []);

  return <div aria-hidden="true" className="adventure-background"><i className="adventure-aurora" /><i className="adventure-contours" /><i className="adventure-route" /></div>;
}
