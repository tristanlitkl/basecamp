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

  it("reserves glass for floating layers and keeps the itinerary spatial", () => {
    expect(styles).toContain(".notification-panel { position: fixed;");
    expect(styles).toContain(".notification-panel");
    expect(styles).toContain("backdrop-filter: blur(14px)");
    expect(styles).toContain(".trip-members-popover");
    expect(styles).toContain("backdrop-filter: blur(16px)");
    expect(styles).toContain(".itinerary-day-header { display: grid;");
    expect(styles).toContain(".itinerary-day-view .timeline::before");
    expect(styles).toContain(".itinerary-day-view .itinerary-row.is-unscheduled > .itinerary-stop");
  });

  it("retains three distinct visual states for candidate and committed trip ideas", () => {
    expect(styles).toContain("#trip-ideas .activity-card-not-in-itinerary");
    expect(styles).toContain("border-style: dashed");
    expect(styles).toContain("#trip-ideas-in-itinerary .activity-card { border-color: #cbd9f4; border-left: 4px solid var(--cobalt);");
    expect(styles).toContain("#trip-ideas-in-itinerary .activity-itinerary-state");
  });
});
