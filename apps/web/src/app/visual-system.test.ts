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

  it("uses a single, distinct visual treatment for candidate and selected trip ideas", () => {
    expect(styles).toContain("#trip-ideas .nested-disclosure {");
    expect(styles).toContain("padding: 20px 0 0;");
    expect(styles).toContain("border: 0;");
    expect(styles).toContain("#trip-ideas .activity-card-not-in-itinerary");
    expect(styles).toContain("border: 1px dashed rgb(220 228 241 / 82%);");
    expect(styles).toContain("#trip-ideas-in-itinerary .activity-card {");
    expect(styles).toContain("background: #f4f7ff;");
    expect(styles).toContain("border-color: transparent;");
    expect(styles).toContain("#trip-ideas-in-itinerary .activity-itinerary-state");
    expect(styles).not.toContain("border-left: 4px solid var(--cobalt)");
  });

  it("keeps the discussion divider inside Trip Idea cards", () => {
    expect(styles).toContain("#trip-ideas details {");
    expect(styles).toContain("margin: 18px 20px 0;");
    expect(styles).toContain("border-top: 1px solid rgb(220 228 241 / 82%);");
  });
});
