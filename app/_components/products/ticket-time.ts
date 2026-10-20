import { useFormatter, useTranslations } from "next-intl";
import { ticketWallClock } from "@/app/_domain/tickets";

/**
 * A ticket time shown as the issuer wrote it: its own wall clock in its own
 * stated offset, never converted to the server's or the viewer's zone (a
 * ticket for 17:30 at +11:00 reads 5:30 pm, UTC+11:00, wherever it is read).
 * The wall clock is formatted as UTC, so no zone moves it, and the offset is
 * named. Null for anything that is not a valid ticket time.
 */
export function useTicketTime() {
  const format = useFormatter();
  const t = useTranslations("tickets");
  return (value: string | null) => {
    const clock = ticketWallClock(value);
    if (!clock) return null;
    const wall = new Date(
      Date.UTC(
        clock.year,
        clock.month - 1,
        clock.day,
        clock.hour,
        clock.minute,
      ),
    );
    return t("timeInZone", {
      time: format.dateTime(wall, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }),
      offset: clock.offset === "Z" ? "" : clock.offset,
    });
  };
}
