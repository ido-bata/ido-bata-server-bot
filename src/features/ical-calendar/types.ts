export type CalendarEvent = {
  uid: string;
  sourceId: string;
  summary: string;
  description: string;
  location: string;
  startAt: Date;
  endAt: Date | null;
  isAllDay: boolean;
};

export type SourceCalendarEntry = {
  events: CalendarEvent[];
  fetchedAt: string;
  sourceId: string;
};

export type CalendarCache = {
  sources: SourceCalendarEntry[];
};

export type CalendarListOptions = {
  now?: Date;
  sourceIds?: string[] | null;
  until: Date;
};

export type CalendarFetchResult = {
  events: CalendarEvent[];
  failedSources: { id: string; reason: string }[];
  fetchedAt: string;
};
