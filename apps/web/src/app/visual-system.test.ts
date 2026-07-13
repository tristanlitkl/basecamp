import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/app/globals.css", "utf8");

describe("Basecamp visual system", () => {
  it("centralizes the command-strip, surface, motion, and focus tokens", () => {
    for (const token of ["--surface-canvas", "--surface-raised", "--cobalt", "--cyan", "--violet", "--shadow-card", "--transition-fast", "--transition-panel", "--scroll-progress", "--aurora-opacity"]) {
      expect(styles).toContain(token);
    }
    expect(styles).toContain(".summary-grid { display: grid;");
    expect(styles).toContain(".btn-secondary");
    expect(styles).toContain("button:focus-visible");
  });

  it("keeps optional decoration inert, responsive, and motion-safe", () => {
    expect(styles).toContain("pointer-events: none");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (max-width: 640px)");
    expect(styles).not.toContain("overflow-x: hidden");
    expect(styles).not.toContain("::-webkit-scrollbar");
    expect(styles).not.toContain("hue-rotate");
  });
});
