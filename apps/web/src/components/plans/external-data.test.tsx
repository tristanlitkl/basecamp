import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalStatusMessage, PlanIntegrations, PlaceSearch, RouteEstimateNotice, WeatherNotice } from "@/components/plans/external-data";
import { discoverNearbyPlaces, getRouteEstimate, getWeather, searchPlaces } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ searchPlaces: vi.fn(), discoverNearbyPlaces: vi.fn(), getRouteEstimate: vi.fn(), getWeather: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Phase 2 external-data UI", () => {
  it("renders cached, stale, approximate, and unavailable statuses explicitly", () => {
    const { rerender } = render(<ExternalStatusMessage kind="place" status="cached" />);
    expect(screen.getByText("Using cached place results.")).toBeTruthy();
    rerender(<ExternalStatusMessage kind="place" status="ok" />);
    expect(screen.getByText("Live place results ready.")).toBeTruthy();
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

  it("exposes nearby discovery, route, weather, and activity-assist actions without automatic provider calls", async () => {
    const usePlace = vi.fn();
    vi.mocked(searchPlaces).mockResolvedValue({ status: "cached", results: [{ name: "Cafe", latitude: 1, longitude: 2, address: "1 Main", type: "cafe" }] });
    vi.mocked(discoverNearbyPlaces).mockResolvedValue({ status: "stale", results: [{ name: "Museum", latitude: 1.01, longitude: 2.01, address: "2 Main", type: "museum" }] });
    vi.mocked(getRouteEstimate).mockResolvedValue({ status: "unavailable", distance_meters: 1609, duration_minutes: 3, approximate: true });
    vi.mocked(getWeather).mockResolvedValue({ status: "cached", temperature_celsius: 20, weather_code: 1, weather_score: 0.8 });
    render(<PlanIntegrations token="jwt" planId="plan" origin={{ lat: 3, lng: 4, name: "Origin" }} onUsePlace={usePlace} />);

    expect(discoverNearbyPlaces).not.toHaveBeenCalled();
    expect(getRouteEstimate).not.toHaveBeenCalled();
    expect(getWeather).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Find a place/), { target: { value: "Cafe" } });
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Cafe" }));
    expect(usePlace).toHaveBeenCalledWith(expect.objectContaining({ name: "Cafe" }));
    fireEvent.click(screen.getByRole("button", { name: "Find nearby places" }));
    await waitFor(() => expect(discoverNearbyPlaces).toHaveBeenCalledWith("jwt", "plan", expect.objectContaining({ placeType: "cafe" })));
    expect(await screen.findByRole("button", { name: "Use Museum" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Estimate route" }));
    expect(await screen.findByText(/displayed estimate is approximate/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check weather" }));
    expect(await screen.findByText("Using cached weather.")).toBeTruthy();
  });
});
