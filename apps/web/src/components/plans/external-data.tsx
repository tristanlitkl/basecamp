"use client";

import React, { useState } from "react";

import { discoverNearbyPlaces, getRouteEstimate, getWeather, searchPlaces } from "@/lib/api-client";
import type { ExternalStatus, PlaceResult, RouteEstimate, WeatherResponse } from "@/types/api";

export function ExternalStatusMessage({ kind, status }: { kind: "place" | "route" | "weather"; status: ExternalStatus }) {
  if (kind === "place") {
    if (status === "ok") return <p className="muted small" role="status">Live place results ready.</p>;
    if (status === "unavailable") return <p className="muted small" role="status">Place search unavailable — you can still add a place manually.</p>;
    if (status === "stale") return <p className="muted small" role="status">Using cached place results while live search is unavailable.</p>;
    if (status === "cached") return <p className="muted small" role="status">Using cached place results.</p>;
  }
  if (kind === "route") {
    if (status === "ok") return <p className="muted small" role="status">Live route estimate ready.</p>;
    if (status === "unavailable") return <p className="muted small" role="status">Route estimate unavailable — itinerary can still be saved. The displayed estimate is approximate.</p>;
    if (status === "stale") return <p className="muted small" role="status">Using cached route estimate.</p>;
    if (status === "cached") return <p className="muted small" role="status">Using cached route estimate.</p>;
  }
  if (status === "ok") return <p className="muted small" role="status">Live weather loaded.</p>;
  if (status === "unavailable") return <p className="muted small" role="status">Weather unavailable — recommendations are using a neutral weather score.</p>;
  if (status === "stale" || status === "cached") return <p className="muted small" role="status">Using cached weather.</p>;
  return null;
}

export function PlaceSearch({ token, planId, disabled, onSelect, label = "Find a place", actionLabel = "Search places" }: { token: string; planId: string; disabled?: boolean; onSelect: (place: PlaceResult) => void; label?: string; actionLabel?: string }) {
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
    <label className="field">{label} <span className="optional">Optional</span><input value={query} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="cluster"><button className="btn btn-secondary" type="button" disabled={disabled || loading || !query.trim()} onClick={() => void submit()}>{loading ? "Searching…" : actionLabel}</button><span className="muted small">Search runs only when you choose Search.</span></div>
    {result && <ExternalStatusMessage kind="place" status={result.status} />}
    {result?.results.map((place) => <button className="btn btn-secondary" key={`${place.latitude}-${place.longitude}-${place.name}`} type="button" onClick={() => onSelect(place)}>Use {place.name}</button>)}
  </div>;
}

function PlaceResults({ results, onSelect }: { results: PlaceResult[]; onSelect: (place: PlaceResult) => void }) {
  if (!results.length) return null;
  return <div className="external-results" aria-label="Place results">{results.map((place) => <button className="btn btn-secondary" key={`${place.latitude}-${place.longitude}-${place.name}`} type="button" onClick={() => onSelect(place)}>Use {place.name}</button>)}</div>;
}

export function PlanIntegrations({
  token, planId, disabled, origin, onUsePlace
}: {
  token: string;
  planId: string;
  disabled?: boolean;
  origin: { lat: number; lng: number; name: string } | null;
  onUsePlace: (place: PlaceResult) => void;
}) {
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [placeType, setPlaceType] = useState("cafe");
  const [nearby, setNearby] = useState<{ status: ExternalStatus; results: PlaceResult[] } | null>(null);
  const [route, setRoute] = useState<RouteEstimate | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [weatherLoading, setWeatherLoading] = useState(false);

  function usePlace(place: PlaceResult) {
    setSelectedPlace(place);
    setRoute(null);
    setWeather(null);
    onUsePlace(place);
  }

  async function findNearby() {
    if (!selectedPlace || !placeType.trim()) return;
    setNearbyLoading(true);
    try {
      const radius = 0.03;
      setNearby(await discoverNearbyPlaces(token, planId, {
        south: selectedPlace.latitude - radius,
        west: selectedPlace.longitude - radius,
        north: selectedPlace.latitude + radius,
        east: selectedPlace.longitude + radius,
        placeType: placeType.trim()
      }));
    } catch {
      setNearby({ status: "unavailable", results: [] });
    } finally {
      setNearbyLoading(false);
    }
  }

  async function estimateRoute() {
    if (!origin || !selectedPlace) return;
    setRouteLoading(true);
    try {
      setRoute(await getRouteEstimate(token, planId, origin, { lat: selectedPlace.latitude, lng: selectedPlace.longitude }));
    } catch {
      setRoute({ status: "unavailable", distance_meters: 0, duration_minutes: 0, approximate: true });
    } finally {
      setRouteLoading(false);
    }
  }

  async function lookupWeather() {
    if (!selectedPlace) return;
    setWeatherLoading(true);
    try {
      setWeather(await getWeather(token, planId, selectedPlace.latitude, selectedPlace.longitude));
    } catch {
      setWeather({ status: "unavailable", temperature_celsius: null, weather_code: null, weather_score: 0.5 });
    } finally {
      setWeatherLoading(false);
    }
  }

  return <section className="card section-card external-integrations" aria-labelledby="explore-places-heading">
    <div className="section-heading"><div><h2 id="explore-places-heading">Explore places</h2><p className="muted small">Search and nearby discovery are optional helpers. You can always add an activity manually.</p></div></div>
    <div className="external-integration-grid">
      <div className="subcard stack"><h3>Place search</h3><PlaceSearch token={token} planId={planId} disabled={disabled} onSelect={usePlace} /></div>
      <div className="subcard stack"><h3>Nearby places</h3><p className="muted small">Choose a place above, then discover a nearby category.</p><label className="field">Place type <input aria-label="Nearby place type" value={placeType} disabled={disabled || nearbyLoading || !selectedPlace} onChange={(event) => setPlaceType(event.target.value)} /></label><button className="btn btn-secondary" type="button" disabled={disabled || nearbyLoading || !selectedPlace || !placeType.trim()} onClick={() => void findNearby()}>{nearbyLoading ? "Finding nearby places…" : "Find nearby places"}</button>{nearby && <ExternalStatusMessage kind="place" status={nearby.status} />}<PlaceResults results={nearby?.results ?? []} onSelect={usePlace} /></div>
      <div className="subcard stack"><h3>Route estimate</h3>{selectedPlace ? <p className="muted small">{origin ? `From ${origin.name} to ${selectedPlace.name}.` : "Add an activity with a location first to use it as the route origin."}</p> : <p className="muted small">Choose a place to estimate a route.</p>}<button className="btn btn-secondary" type="button" disabled={disabled || routeLoading || !origin || !selectedPlace} onClick={() => void estimateRoute()}>{routeLoading ? "Estimating route…" : "Estimate route"}</button><RouteEstimateNotice estimate={route} /></div>
      <div className="subcard stack"><h3>Weather</h3><p className="muted small">Weather is optional and never blocks manual activity entry.</p><button className="btn btn-secondary" type="button" disabled={disabled || weatherLoading || !selectedPlace} onClick={() => void lookupWeather()}>{weatherLoading ? "Checking weather…" : "Check weather"}</button><WeatherNotice weather={weather} /></div>
    </div>
    {selectedPlace && <div className="notice external-selected-place"><strong>{selectedPlace.name}</strong><span> is ready to use in the activity form.</span></div>}
  </section>;
}

export function RouteEstimateNotice({ estimate }: { estimate: RouteEstimate | null }) {
  if (!estimate) return null;
  return <div><ExternalStatusMessage kind="route" status={estimate.status} /><p className="muted small">{(estimate.distance_meters / 1609.344).toFixed(1)} mi · {estimate.duration_minutes} min{estimate.approximate ? " (approximate)" : ""}</p></div>;
}

export function WeatherNotice({ weather }: { weather: WeatherResponse | null }) {
  if (!weather) return null;
  return <div><ExternalStatusMessage kind="weather" status={weather.status} />{weather.temperature_celsius !== null && <p className="muted small">Weather: {weather.temperature_celsius.toFixed(1)}°C</p>}</div>;
}
