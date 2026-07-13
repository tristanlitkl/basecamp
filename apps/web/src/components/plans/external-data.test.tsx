import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalStatusMessage, PlaceSearch, RouteEstimateNotice, WeatherNotice } from "@/components/plans/external-data";
import { searchPlaces } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ searchPlaces: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Phase 2 external-data UI", () => {
  it("renders cached, stale, approximate, and unavailable statuses explicitly", () => {
    const { rerender } = render(<ExternalStatusMessage kind="place" status="cached" />);
    expect(screen.getByText("Using cached place results.")).toBeTruthy();
    rerender(<ExternalStatusMessage kind="place" status="stale" />);
    expect(screen.getByText(/Using cached place results while live search is unavailable/)).toBeTruthy();
    rerender(<RouteEstimateNotice estimate={{ status: "unavailable", distance_meters: 1609, duration_minutes: 3, approximate: true }} />);
    expect(screen.getAllByText(/approximate/i)).toHaveLength(2);
    rerender(<WeatherNotice weather={{ status: "unavailable", temperature_celsius: null, weather_code: null, weather_score: 0.5 }} />);
    expect(screen.getByText(/Weather unavailable/)).toBeTruthy();
  });

  it("uses an explicit action rather than searching on every address keystroke", async () => {
    let resolve!: (value: { status: "ok"; results: Array<{ name: string; latitude: number; longitude: number; address: string; type: string }> }) => void;
    vi.mocked(searchPlaces).mockReturnValue(new Promise((done) => { resolve = done; }));
    const select = vi.fn();
    render(<PlaceSearch token="jwt" planId="plan" onSelect={select} />);
    fireEvent.change(screen.getByLabelText(/Find a place/), { target: { value: "Cafe" } });
    expect(searchPlaces).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    await waitFor(() => expect(searchPlaces).toHaveBeenCalledWith("jwt", "plan", "Cafe"));
    expect(screen.getByRole("button", { name: "Searching…" })).toBeTruthy();
    resolve({ status: "ok", results: [{ name: "Cafe", latitude: 1, longitude: 2, address: "1 Main", type: "cafe" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Use Cafe" }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ address: "1 Main" }));
  });

  it("keeps manual entry available and does not erase it when place search is unavailable", async () => {
    vi.mocked(searchPlaces).mockResolvedValue({ status: "unavailable", results: [] });
    render(<PlaceSearch token="jwt" planId="plan" onSelect={vi.fn()} />);
    const input = screen.getByLabelText(/Find a place/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Manual address" } });
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    expect(await screen.findByText(/Place search unavailable/)).toBeTruthy();
    expect(input.value).toBe("Manual address");
  });
});
