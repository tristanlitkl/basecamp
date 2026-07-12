import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmojiPicker } from "@/components/ui/emoji-picker";

describe("EmojiPicker", () => {
  it("labels choices accessibly and announces the selected supported emoji", () => {
    const onChange = vi.fn();
    render(<EmojiPicker onChange={onChange} value="🧭" />);

    const fox = screen.getByRole("button", { name: "Choose fox emoji" });
    expect(screen.getByText(/Selected avatar:/)).toBeTruthy();
    fireEvent.click(fox);
    expect(onChange).toHaveBeenCalledWith("🦊");
  });
});
