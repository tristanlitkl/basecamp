"use client";

import React, { useEffect, useMemo, useState } from "react";

import type { DateAvailability, DateSuggestion, PlanMember, PlanSummary } from "@/types/api";

type CalendarDay = {
  date: string;
  available: number;
  maybe: number;
  unavailable: number;
  noResponse: number;
  isCurrentTripDate: boolean;
  hasOpenSuggestion: boolean;
};

type AvailabilityCalendarProps = {
  plan: PlanSummary;
  members: PlanMember[];
  availability: DateAvailability[];
  suggestions: DateSuggestion[];
  onOpenEditor?: () => void;
};

/** Date-only utilities deliberately avoid `new Date("YYYY-MM-DD")` local-time parsing. */
function dayKey(value: string) { return value.slice(0, 10); }
function fromDayKey(value: string) { return new Date(`${dayKey(value)}T00:00:00.000Z`); }
function addDays(value: string, amount: number) {
  const date = fromDayKey(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function monthKey(value: string) { return dayKey(value).slice(0, 7); }
function monthStart(value: string) { return `${monthKey(value)}-01`; }
function addMonths(value: string, amount: number) {
  const date = fromDayKey(monthStart(value));
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}
function daysInMonth(value: string) {
  const start = fromDayKey(monthStart(value));
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
}
function inRange(date: string, start: string | null | undefined, end: string | null | undefined) {
  return Boolean(start && end && date >= dayKey(start) && date <= dayKey(end));
}
function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(fromDayKey(value));
}
function fullDateLabel(value: string) { return dateLabel(value, { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
function sortedSuggestions(suggestions: DateSuggestion[]) {
  return [...suggestions].sort((left, right) => right.yes_votes - left.yes_votes || right.maybe_votes - left.maybe_votes || left.no_votes - right.no_votes || left.starts_on.localeCompare(right.starts_on) || (left.created_at ?? "").localeCompare(right.created_at ?? ""));
}
function availabilitySummary(day: CalendarDay) {
  const parts = [`${day.available} available`, `${day.maybe} maybe`, `${day.unavailable} unavailable`, `${day.noResponse} no response`];
  if (day.isCurrentTripDate) parts.unshift("current trip date");
  if (day.hasOpenSuggestion) parts.push("open date option");
  return parts.join(", ");
}

export function AvailabilityCalendar({ plan, members, availability, suggestions, onOpenEditor }: AvailabilityCalendarProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const boundaries = useMemo(() => [plan.starts_on, plan.ends_on, ...availability.map((entry) => entry.date), ...suggestions.flatMap((suggestion) => [suggestion.starts_on, suggestion.ends_on])]
    .filter((value): value is string => Boolean(value)).map(dayKey), [plan.starts_on, plan.ends_on, availability, suggestions]);
  const earliest = boundaries.length ? boundaries.reduce((first, value) => value < first ? value : first) : null;
  const latest = boundaries.length ? boundaries.reduce((last, value) => value > last ? value : last) : null;
  const months = useMemo(() => {
    if (!earliest || !latest) return [] as string[];
    const keys: string[] = [];
    for (let key = monthKey(earliest); key <= monthKey(latest); key = addMonths(key, 1)) keys.push(key);
    return keys;
  }, [earliest, latest]);
  // Selection is only a detail panel. Reset it when an authoritative range replacement removes its day.
  useEffect(() => {
    if (selectedDate && (!earliest || !latest || selectedDate < earliest || selectedDate > latest)) setSelectedDate(null);
  }, [selectedDate, earliest, latest]);

  const availabilityByDate = useMemo(() => {
    const byDate = new Map<string, DateAvailability[]>();
    for (const entry of availability) {
      const key = dayKey(entry.date);
      byDate.set(key, [...(byDate.get(key) ?? []), entry]);
    }
    return byDate;
  }, [availability]);
  const dayFor = (date: string): CalendarDay => {
    const entries = availabilityByDate.get(date) ?? [];
    const counts = { available: 0, maybe: 0, unavailable: 0 };
    for (const entry of entries) counts[entry.status] += 1;
    return {
      date, ...counts, noResponse: Math.max(0, members.length - entries.length),
      isCurrentTripDate: inRange(date, plan.starts_on, plan.ends_on),
      hasOpenSuggestion: suggestions.some((suggestion) => suggestion.status === "open" && inRange(date, suggestion.starts_on, suggestion.ends_on)),
    };
  };
  const selected = selectedDate ? dayFor(selectedDate) : null;
  const selectedEntries = selected ? availabilityByDate.get(selected.date) ?? [] : [];
  const selectionsByMember = new Map(selectedEntries.map((entry) => [entry.user_id, entry]));
  const leadingSuggestion = sortedSuggestions(suggestions).find((suggestion) => suggestion.status === "open") ?? sortedSuggestions(suggestions)[0];

  if (!earliest || !latest) return <section aria-labelledby="availability-calendar-heading" className="availability-calendar">
    <div className="calendar-heading"><div><p className="eyebrow">Coordinate</p><h2 id="availability-calendar-heading">Group availability</h2><p className="muted small">Set trip dates or add a date option to begin comparing group availability.</p></div>{onOpenEditor ? <button className="btn btn-secondary" type="button" onClick={onOpenEditor}>Open date window</button> : null}</div><CalendarLegend />
  </section>;

  return <section aria-labelledby="availability-calendar-heading" className="availability-calendar">
    <div className="calendar-heading"><div><p className="eyebrow">Coordinate</p><h2 id="availability-calendar-heading">Group availability</h2><p className="muted small">{dateLabel(earliest, { month: "long", day: "numeric", year: "numeric" })} – {dateLabel(latest, { month: "long", day: "numeric", year: "numeric" })}</p></div>{onOpenEditor ? <button className="btn btn-secondary" type="button" onClick={onOpenEditor}>Update availability</button> : null}</div>
    {leadingSuggestion && <p className="calendar-leading" aria-label={`Leading date option: ${dateLabel(leadingSuggestion.starts_on)} through ${dateLabel(leadingSuggestion.ends_on)}, ${leadingSuggestion.yes_votes} yes, ${leadingSuggestion.maybe_votes} maybe, ${leadingSuggestion.no_votes} no`}><strong>Leading option</strong><span>{dateLabel(leadingSuggestion.starts_on)} – {dateLabel(leadingSuggestion.ends_on)} · ✓ {leadingSuggestion.yes_votes} · ❓ {leadingSuggestion.maybe_votes} · × {leadingSuggestion.no_votes}</span></p>}
    <CalendarLegend />
    <div className="calendar-months" aria-label="Availability calendar">
      {months.map((month) => {
        const firstDay = monthStart(month);
        const days = Array.from({ length: daysInMonth(month) }, (_, index) => dayFor(addDays(firstDay, index)));
        return <section className="calendar-month" key={month} aria-label={dateLabel(firstDay, { month: "long", year: "numeric" })}>
          <h3>{dateLabel(firstDay, { month: "long", year: "numeric" })}</h3><div className="calendar-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
          <div className="calendar-days">{Array.from({ length: fromDayKey(firstDay).getUTCDay() }, (_, index) => <span className="calendar-blank" key={`blank-${index}`} />)}
            {days.map((day) => <button aria-label={`${fullDateLabel(day.date)}: ${availabilitySummary(day)}. Select to view member details.`} aria-pressed={selectedDate === day.date} className={`calendar-day${day.isCurrentTripDate ? " is-current" : ""}${day.hasOpenSuggestion ? " has-open-option" : ""}`} key={day.date} onClick={() => setSelectedDate(day.date)} type="button"><time dateTime={day.date}>{fromDayKey(day.date).getUTCDate()}</time><span aria-hidden="true" className="calendar-availability-count">✓{day.available}</span><span aria-hidden="true" className="calendar-cell-markers">{day.maybe > 0 ? "❓" : ""}{day.unavailable > 0 ? "×" : ""}{day.noResponse > 0 ? "–" : ""}</span></button>)}</div>
        </section>;
      })}
    </div>
    {selected && <section aria-live="polite" className="calendar-detail" id="availability-calendar-detail"><div><h3>Availability for {fullDateLabel(selected.date)}</h3><p className="muted small">{availabilitySummary(selected)}</p></div><ul>{members.map((member) => { const response = selectionsByMember.get(member.user_id); const label = response ? response.status === "available" ? "✓ Available" : response.status === "maybe" ? "❓ Maybe" : "× Unavailable" : "– No response"; return <li key={member.user_id}><span>{member.display_name}</span><strong className={`calendar-member-status ${response ? `status-${response.status}` : "status-no-response"}`}>{label}</strong></li>; })}</ul></section>}
  </section>;
}

function CalendarLegend() { return <ul aria-label="Calendar legend" className="calendar-legend"><li><span aria-hidden="true" className="legend-mark legend-current">✓</span>Current trip date</li><li><span aria-hidden="true" className="legend-mark legend-option">··</span>Open date option</li><li><span aria-hidden="true" className="legend-mark">✓</span>Available</li><li><span aria-hidden="true" className="legend-mark">❓</span>Maybe</li><li><span aria-hidden="true" className="legend-mark">×</span>Unavailable</li><li><span aria-hidden="true" className="legend-mark">–</span>No response</li></ul>; }
