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
});
