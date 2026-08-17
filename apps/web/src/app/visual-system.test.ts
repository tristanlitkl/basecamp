import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/app/globals.css", "utf8");
const planPageStyles = readFileSync("src/app/plans/[planId]/page.module.css", "utf8");

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

  it("uses a single, distinct visual treatment for candidate and selected trip ideas", () => {
    expect(planPageStyles).toContain("#trip-ideas .nested-disclosure) { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none;");
    expect(styles).toContain("#trip-ideas .activity-card-not-in-itinerary {");
    expect(styles).not.toContain("border: 1px dashed rgb(220 228 241 / 82%);");
    expect(planPageStyles).toContain("#trip-ideas .activity-card-not-in-itinerary) { border: 0;");
    expect(planPageStyles).not.toContain("activity-card-not-in-itinerary) { border: 1px dashed");
    expect(planPageStyles).toContain("#trip-ideas .activity-card-in-itinerary) { position: relative; border: 0;");
    expect(planPageStyles).toContain("activity-card-in-itinerary::before) { position: absolute;");
    expect(planPageStyles).toContain("top: 10px; bottom: 10px; left: 10px; width: 4px;");
    expect(planPageStyles).toContain("activity-card-in-itinerary > *) { position: relative; z-index: 1; }");
    expect(planPageStyles).not.toContain("activity-card-in-itinerary) { border: 1px");
    expect(planPageStyles).not.toContain("border-left: 4px solid var(--travel-cobalt)");
  });

  it("keeps the discussion divider inside Trip Idea cards", () => {
    expect(planPageStyles).toContain("#trip-ideas details) { margin: 18px 24px 0;");
    expect(planPageStyles).toContain("border-top: 1px solid #e8edf4;");
  });
});
