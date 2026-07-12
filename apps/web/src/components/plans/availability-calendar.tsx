"use client";

import React, { useState } from "react";

import type { DateAvailability, DateSuggestion, PlanMember, PlanSummary } from "@/types/api";

type CalendarDay = {
  date: string;
  available: number;
  maybe: number;
  unavailable: number;
  noResponse: number;
  isPlanDate: boolean;
  hasAcceptedSuggestion: boolean;
  hasOpenSuggestion: boolean;
  hasDismissedSuggestion: boolean;
};

type AvailabilityCalendarProps = {
  plan: PlanSummary;
  members: PlanMember[];
  availability: DateAvailability[];
  suggestions: DateSuggestion[];
};

function dayKey(value: string) {
  return value.slice(0, 10);
}

function fromDayKey(value: string) {
  return new Date(`${dayKey(value)}T00:00:00.000Z`);
}

function addDays(value: string, amount: number) {
  const date = fromDayKey(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function inRange(date: string, start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return false;
  return date >= dayKey(start) && date <= dayKey(end);
}

function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(fromDayKey(value));
}

function fullDateLabel(value: string) {
  return dateLabel(value, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function sortedSuggestions(suggestions: DateSuggestion[]) {
  return [...suggestions].sort((left, right) =>
    right.yes_votes - left.yes_votes ||
    right.maybe_votes - left.maybe_votes ||
    left.no_votes - right.no_votes ||
    left.starts_on.localeCompare(right.starts_on) ||
    (left.created_at ?? "").localeCompare(right.created_at ?? "")
  );
}

function availabilitySummary(day: CalendarDay) {
  const parts = [
    `${day.available} available`,
    `${day.maybe} maybe`,
    `${day.unavailable} unavailable`,
    `${day.noResponse} no response`
  ];
  if (day.hasAcceptedSuggestion) parts.unshift("accepted trip date");
  else if (day.isPlanDate) parts.unshift("proposed trip date");
  if (day.hasOpenSuggestion) parts.push("open date option");
  if (day.hasDismissedSuggestion) parts.push("dismissed date option");
  return parts.join(", ");
}

export function AvailabilityCalendar({ plan, members, availability, suggestions }: AvailabilityCalendarProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const boundaries = [
    plan.starts_on,
    plan.ends_on,
    ...availability.map((entry) => entry.date),
    ...suggestions.flatMap((suggestion) => [suggestion.starts_on, suggestion.ends_on])
  ].filter((value): value is string => Boolean(value)).map(dayKey);

  const earliest = boundaries.length ? boundaries.reduce((first, value) => value < first ? value : first) : null;
  const latest = boundaries.length ? boundaries.reduce((last, value) => value > last ? value : last) : null;
  const relevantSuggestions = sortedSuggestions(suggestions);
  const leadingSuggestion = relevantSuggestions.find((suggestion) => suggestion.status === "open") ?? relevantSuggestions[0];

  if (!earliest || !latest) {
    return <section aria-labelledby="availability-calendar-heading" className="availability-calendar">
      <div className="calendar-heading"><div><p className="eyebrow">Coordinate</p><h2 id="availability-calendar-heading">Group availability</h2><p className="muted small">Set trip dates or add a date option to begin comparing the group’s availability.</p></div><a className="btn btn-secondary" href="#travel-window">Open travel window</a></div>
      <CalendarLegend />
    </section>;
  }

  const availabilityByDate = new Map<string, DateAvailability[]>();
  for (const entry of availability) {
    const entries = availabilityByDate.get(dayKey(entry.date)) ?? [];
    entries.push(entry);
    availabilityByDate.set(dayKey(entry.date), entries);
  }

  const days: CalendarDay[] = [];
  for (let date = earliest; date <= latest; date = addDays(date, 1)) {
    const entries = availabilityByDate.get(date) ?? [];
    const counts = { available: 0, maybe: 0, unavailable: 0 };
    for (const entry of entries) counts[entry.status] += 1;
    days.push({
      date,
      ...counts,
      noResponse: Math.max(0, members.length - entries.length),
      isPlanDate: inRange(date, plan.starts_on, plan.ends_on),
      hasAcceptedSuggestion: suggestions.some((suggestion) => suggestion.status === "accepted" && inRange(date, suggestion.starts_on, suggestion.ends_on)),
      hasOpenSuggestion: suggestions.some((suggestion) => suggestion.status === "open" && inRange(date, suggestion.starts_on, suggestion.ends_on)),
      hasDismissedSuggestion: suggestions.some((suggestion) => suggestion.status === "dismissed" && inRange(date, suggestion.starts_on, suggestion.ends_on))
    });
  }
  const selected = days.find((day) => day.date === selectedDate) ?? null;
  const selectedEntries = selected ? availabilityByDate.get(selected.date) ?? [] : [];
  const selectionsByMember = new Map(selectedEntries.map((entry) => [entry.user_id, entry]));
  const months = new Map<string, CalendarDay[]>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), day]);
  }

  return <section aria-labelledby="availability-calendar-heading" className="availability-calendar">
    <div className="calendar-heading"><div><p className="eyebrow">Coordinate</p><h2 id="availability-calendar-heading">Group availability</h2><p className="muted small">{dateLabel(earliest, { month: "long", day: "numeric", year: "numeric" })} – {dateLabel(latest, { month: "long", day: "numeric", year: "numeric" })}</p></div><a className="btn btn-secondary" href="#travel-window">Update availability</a></div>
    {leadingSuggestion && <p className="calendar-leading" aria-label={`Leading date option: ${dateLabel(leadingSuggestion.starts_on)} through ${dateLabel(leadingSuggestion.ends_on)}, ${leadingSuggestion.yes_votes} yes, ${leadingSuggestion.maybe_votes} maybe, ${leadingSuggestion.no_votes} no`}><strong>Leading option</strong><span>{dateLabel(leadingSuggestion.starts_on)} – {dateLabel(leadingSuggestion.ends_on)} · ✓ {leadingSuggestion.yes_votes} · ~ {leadingSuggestion.maybe_votes} · × {leadingSuggestion.no_votes}</span></p>}
    <CalendarLegend />
    <div className="calendar-months" aria-label="Availability calendar">
      {[...months.entries()].map(([month, monthDays]) => <section className="calendar-month" key={month} aria-label={dateLabel(monthDays[0].date, { month: "long", year: "numeric" })}>
        <h3>{dateLabel(monthDays[0].date, { month: "long", year: "numeric" })}</h3>
        <div className="calendar-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
        <div className="calendar-days">
          {Array.from({ length: fromDayKey(monthDays[0].date).getUTCDay() }, (_, index) => <span className="calendar-blank" key={`blank-${index}`} />)}
          {monthDays.map((day) => <button
            aria-label={`${fullDateLabel(day.date)}: ${availabilitySummary(day)}. Select to view member details.`}
            aria-pressed={selectedDate === day.date}
            className={`calendar-day${day.hasAcceptedSuggestion ? " is-accepted" : ""}${day.isPlanDate ? " is-proposed" : ""}${day.hasOpenSuggestion ? " has-open-option" : ""}${day.hasDismissedSuggestion ? " has-dismissed-option" : ""}`}
            key={day.date}
            onClick={() => setSelectedDate(day.date)}
            type="button"
          ><time dateTime={day.date}>{fromDayKey(day.date).getUTCDate()}</time><span aria-hidden="true" className="calendar-availability-count">✓{day.available}</span><span aria-hidden="true" className="calendar-cell-markers">{day.maybe > 0 ? "~" : ""}{day.unavailable > 0 ? "×" : ""}{day.noResponse > 0 ? "–" : ""}</span></button>)}
        </div>
      </section>)}
    </div>
    {selected && <section aria-live="polite" className="calendar-detail" id="availability-calendar-detail">
      <div><h3>Availability for {fullDateLabel(selected.date)}</h3><p className="muted small">{availabilitySummary(selected)}</p></div>
      <ul>{members.map((member) => {
        const response = selectionsByMember.get(member.user_id);
        const label = response ? response.status === "available" ? "✓ Available" : response.status === "maybe" ? "~ Maybe" : "× Unavailable" : "– No response";
        return <li key={member.user_id}><span>{member.display_name}</span><strong className={`calendar-member-status ${response ? `status-${response.status}` : "status-no-response"}`}>{label}</strong></li>;
      })}</ul>
    </section>}
  </section>;
}

function CalendarLegend() {
  return <ul aria-label="Calendar legend" className="calendar-legend">
    <li><span aria-hidden="true" className="legend-mark legend-accepted">✓</span>Accepted trip date</li>
    <li><span aria-hidden="true" className="legend-mark legend-proposed">□</span>Proposed trip date</li>
    <li><span aria-hidden="true" className="legend-mark legend-option">··</span>Open date option</li>
    <li><span aria-hidden="true" className="legend-mark">✓</span>Available</li>
    <li><span aria-hidden="true" className="legend-mark">~</span>Maybe</li>
    <li><span aria-hidden="true" className="legend-mark">×</span>Unavailable</li>
    <li><span aria-hidden="true" className="legend-mark">–</span>No response</li>
  </ul>;
}
