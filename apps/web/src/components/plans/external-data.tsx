"use client";

import React, { useState } from "react";

import { searchPlaces } from "@/lib/api-client";
import type { ExternalStatus, PlaceResult, RouteEstimate, WeatherResponse } from "@/types/api";

export function ExternalStatusMessage({ kind, status }: { kind: "place" | "route" | "weather"; status: ExternalStatus }) {
  if (kind === "place") {
    if (status === "unavailable") return <p className="muted small" role="status">Place search unavailable — you can still add a place manually.</p>;
    if (status === "stale") return <p className="muted small" role="status">Using cached place results while live search is unavailable.</p>;
    if (status === "cached") return <p className="muted small" role="status">Using cached place results.</p>;
  }
  if (kind === "route") {
    if (status === "unavailable") return <p className="muted small" role="status">Route estimate unavailable — itinerary can still be saved. The displayed estimate is approximate.</p>;
    if (status === "stale") return <p className="muted small" role="status">Using cached route estimate.</p>;
    if (status === "cached") return <p className="muted small" role="status">Using cached route estimate.</p>;
  }
  if (status === "unavailable") return <p className="muted small" role="status">Weather unavailable — recommendations are using a neutral weather score.</p>;
  if (status === "stale" || status === "cached") return <p className="muted small" role="status">Using cached weather.</p>;
  return null;
}

export function PlaceSearch({ token, planId, disabled, onSelect }: { token: string; planId: string; disabled?: boolean; onSelect: (place: PlaceResult) => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ status: ExternalStatus; results: PlaceResult[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!query.trim()) return;
    setLoading(true);
    try { setResult(await searchPlaces(token, planId, query.trim())); }
    catch { setResult({ status: "unavailable", results: [] }); }
    finally { setLoading(false); }
  }

  return <div className="subcard stack" aria-label="Place search">
    <label className="field">Find a place <span className="optional">Optional</span><input value={query} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="cluster"><button className="btn btn-secondary" type="button" disabled={disabled || loading || !query.trim()} onClick={() => void submit()}>{loading ? "Searching…" : "Search places"}</button><span className="muted small">Search runs only when you choose Search.</span></div>
    {result && <ExternalStatusMessage kind="place" status={result.status} />}
    {result?.results.map((place) => <button className="btn btn-secondary" key={`${place.latitude}-${place.longitude}-${place.name}`} type="button" onClick={() => onSelect(place)}>Use {place.name}</button>)}
  </div>;
}

export function RouteEstimateNotice({ estimate }: { estimate: RouteEstimate | null }) {
  if (!estimate) return null;
  return <div><ExternalStatusMessage kind="route" status={estimate.status} /><p className="muted small">{(estimate.distance_meters / 1609.344).toFixed(1)} mi · {estimate.duration_minutes} min{estimate.approximate ? " (approximate)" : ""}</p></div>;
}

export function WeatherNotice({ weather }: { weather: WeatherResponse | null }) {
  if (!weather) return null;
  return <div><ExternalStatusMessage kind="weather" status={weather.status} />{weather.temperature_celsius !== null && <p className="muted small">Weather: {weather.temperature_celsius.toFixed(1)}°C</p>}</div>;
}
