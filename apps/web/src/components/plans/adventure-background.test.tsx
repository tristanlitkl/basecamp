import React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdventureBackground } from "@/components/plans/adventure-background";

describe("AdventureBackground", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders static decorative shapes without scroll listeners in reduced-motion mode", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { container } = render(<AdventureBackground />);
    expect(container.querySelectorAll(".adventure-background i")).toHaveLength(3);
    expect(addEventListener).not.toHaveBeenCalledWith("scroll", expect.anything(), expect.anything());
  });

  it("renders decoration as one aria-hidden fixed-layer host rather than layout content", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { container } = render(<AdventureBackground />);
    const background = container.firstElementChild;
    expect(background?.className).toBe("adventure-background");
    expect(background?.getAttribute("aria-hidden")).toBe("true");
    expect(container.children).toHaveLength(1);
  });

  it("uses one passive scroll listener and cleans up its listener and pending frame", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(19);
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<AdventureBackground />);
    const scrollRegistration = addEventListener.mock.calls.find(([type]) => type === "scroll");
    expect(scrollRegistration?.[2]).toEqual({ passive: true });
    window.dispatchEvent(new Event("scroll"));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("scroll", scrollRegistration?.[1]);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(19);
  });
});
