"use client";

import React, { useState } from "react";

import { ApiError, discoverNearbyPlaces, getRouteEstimate, getWeather, searchPlaces } from "@/lib/api-client";
import type { ExternalStatus, PlaceResult, RouteEstimate, WeatherResponse } from "@/types/api";

function requestErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "Network or CORS failure — check your connection and try again. Your current entries were kept.";
  const messages: Record<number, string> = {
    401: "Your session expired. Sign in again, then retry this request.",
    403: "You do not have permission to use external data for this plan.",
    404: "This plan or external-data endpoint could not be found.",
    422: "Check the search text or selected coordinates and try again.",
    429: "The place provider is busy. Please wait a moment before trying again.",
    500: "The provider is temporarily unavailable. Your manual activity entry is still available."
  };
  return messages[error.status] ?? `Request failed (HTTP ${error.status}). Your current entries were kept.`;
}

function ExternalRequestError({ error }: { error: unknown | null }) {
  return error ? <p className="alert small" role="alert">{requestErrorMessage(error)}</p> : null;
}

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

export function PlaceSearch({ token, planId, disabled, onSelect, label = "Find a place", actionLabel = "Search places", useLabel = "Use place" }: { token: string; planId: string; disabled?: boolean; onSelect: (place: PlaceResult) => void; label?: string; actionLabel?: string; useLabel?: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ status: ExternalStatus; results: PlaceResult[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function submit() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try { setResult(await searchPlaces(token, planId, query.trim())); }
    catch (value) { setError(value); }
    finally { setLoading(false); }
  }

  return <div className="subcard stack" aria-label="Place search">
    <label className="field">{label} <span className="optional">Optional</span><input value={query} disabled={disabled || loading} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="cluster"><button className="btn btn-secondary" type="button" disabled={disabled || loading || !query.trim()} onClick={() => void submit()}>{loading ? "Searching…" : actionLabel}</button><span className="muted small">Search runs only when you choose Search.</span></div>
    {result && <ExternalStatusMessage kind="place" status={result.status} />}
    <ExternalRequestError error={error} />
    <PlaceResults results={result?.results ?? []} onSelect={onSelect} useLabel={useLabel} />
  </div>;
}

function PlaceResults({ results, onSelect, useLabel = "Use place" }: { results: PlaceResult[]; onSelect: (place: PlaceResult) => void; useLabel?: string }) {
  if (!results.length) return null;
  return <div className="external-results" aria-label="Place results">{results.map((place) => <article className="external-place-result" key={`${place.latitude}-${place.longitude}-${place.name}`}><div><strong>{place.name}</strong><p className="muted small">{place.address || "Address unavailable"}{place.type ? ` · ${place.type}` : ""}</p></div><button className="btn btn-secondary" type="button" onClick={() => onSelect(place)}>{useLabel}</button></article>)}</div>;
}

export function PlanIntegrations({
  token, planId, disabled, onUsePlace
}: {
  token: string;
  planId: string;
  disabled?: boolean;
  onUsePlace: (place: PlaceResult) => void;
}) {
  const [origin, setOrigin] = useState<PlaceResult | null>(null);
  const [destination, setDestination] = useState<PlaceResult | null>(null);
  const [placeType, setPlaceType] = useState("cafe");
  const [nearby, setNearby] = useState<{ status: ExternalStatus; results: PlaceResult[] } | null>(null);
  const [route, setRoute] = useState<RouteEstimate | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<unknown | null>(null);
  const [routeError, setRouteError] = useState<unknown | null>(null);
  const [weatherError, setWeatherError] = useState<unknown | null>(null);

  function useDestination(place: PlaceResult) {
    setDestination(place);
    setRoute(null);
    setWeather(null);
    onUsePlace(place);
  }

  async function findNearby() {
    if (!destination || !placeType.trim()) return;
    setNearbyLoading(true);
    setNearbyError(null);
    try {
      const radius = 0.03;
      setNearby(await discoverNearbyPlaces(token, planId, {
        south: destination.latitude - radius,
        west: destination.longitude - radius,
        north: destination.latitude + radius,
        east: destination.longitude + radius,
        placeType: placeType.trim()
      }));
    } catch (value) {
      setNearbyError(value);
    } finally {
      setNearbyLoading(false);
    }
  }

  async function estimateRoute() {
    if (!origin || !destination) return;
    setRouteLoading(true);
    setRouteError(null);
    try {
      setRoute(await getRouteEstimate(token, planId, { lat: origin.latitude, lng: origin.longitude }, { lat: destination.latitude, lng: destination.longitude }));
    } catch (value) {
      setRouteError(value);
    } finally {
      setRouteLoading(false);
    }
  }

  async function lookupWeather() {
    if (!destination) return;
    setWeatherLoading(true);
    setWeatherError(null);
    try {
      setWeather(await getWeather(token, planId, destination.latitude, destination.longitude));
    } catch (value) {
      setWeatherError(value);
    } finally {
      setWeatherLoading(false);
    }
  }

  return <section className="card section-card external-integrations" aria-labelledby="explore-places-heading">
    <div className="section-heading"><div><h2 id="explore-places-heading">Explore places</h2><p className="muted small">Search and nearby discovery are optional helpers. You can always add an activity manually.</p></div></div>
    <div className="external-integration-grid">
      <div className="subcard stack"><h3>Destination</h3><PlaceSearch token={token} planId={planId} disabled={disabled} label="Search and select destination" actionLabel="Search destinations" useLabel="Use destination" onSelect={useDestination} />{destination && <p className="muted small">Selected destination: {destination.name}</p>}</div>
      <div className="subcard stack"><h3>Nearby places</h3><p className="muted small">{destination ? `Find places near ${destination.name}.` : "Select a destination or center point first."}</p><label className="field">Place type <input aria-label="Nearby place type" value={placeType} disabled={disabled || nearbyLoading} onChange={(event) => setPlaceType(event.target.value)} /></label><button className="btn btn-secondary" type="button" aria-describedby={!destination ? "nearby-prerequisite" : undefined} disabled={disabled || nearbyLoading || !destination || !placeType.trim()} onClick={() => void findNearby()}>{nearbyLoading ? "Finding nearby places…" : "Find nearby"}</button>{!destination && <p className="muted small" id="nearby-prerequisite">A selected destination or center point is required.</p>}{nearby && <ExternalStatusMessage kind="place" status={nearby.status} />}<ExternalRequestError error={nearbyError} /><PlaceResults results={nearby?.results ?? []} onSelect={useDestination} useLabel="Use nearby place" /></div>
      <div className="subcard stack"><h3>Route estimate</h3><PlaceSearch token={token} planId={planId} disabled={disabled} label="Search and select origin" actionLabel="Search origins" useLabel="Use origin" onSelect={(place) => { setOrigin(place); setRoute(null); }} />{origin && <p className="muted small">From: {origin.name}</p>}{destination && <p className="muted small">To: {destination.name}</p>}<button className="btn btn-secondary" type="button" aria-describedby={(!origin || !destination) ? "route-prerequisite" : undefined} disabled={disabled || routeLoading || !origin || !destination} onClick={() => void estimateRoute()}>{routeLoading ? "Estimating route…" : "Estimate route"}</button>{(!origin || !destination) && <p className="muted small" id="route-prerequisite">Select both an origin and destination with coordinates to estimate a route.</p>}<ExternalRequestError error={routeError} /><RouteEstimateNotice estimate={route} /></div>
      <div className="subcard stack"><h3>Weather</h3><p className="muted small">{destination ? `Forecast for ${destination.name}.` : "Select a destination to check weather."}</p><button className="btn btn-secondary" type="button" disabled={disabled || weatherLoading || !destination} onClick={() => void lookupWeather()}>{weatherLoading ? "Checking weather…" : "Check weather"}</button><ExternalRequestError error={weatherError} /><WeatherNotice weather={weather} /></div>
    </div>
    {destination && <div className="notice external-selected-place"><strong>{destination.name}</strong><span> is ready to use in the activity form.</span></div>}
  </section>;
}

export function RouteEstimateNotice({ estimate }: { estimate: RouteEstimate | null }) {
  if (!estimate) return null;
  return <div><ExternalStatusMessage kind="route" status={estimate.status} /><p className="muted small">{(estimate.distance_meters / 1609.344).toFixed(1)} mi · {estimate.duration_minutes} min{estimate.approximate ? " (approximate)" : ""}</p></div>;
}

export function WeatherNotice({ weather }: { weather: WeatherResponse | null }) {
  if (!weather) return null;
  return <div><ExternalStatusMessage kind="weather" status={weather.status} />{weather.temperature_celsius !== null && <p className="muted small">Weather: {weather.temperature_celsius.toFixed(1)}°C{weather.weather_code !== null ? ` · conditions code ${weather.weather_code}` : ""}</p>}<p className="muted small">Forecast time: current requested hour.</p></div>;
}
