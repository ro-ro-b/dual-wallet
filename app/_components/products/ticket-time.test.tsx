import { render, screen } from "@testing-library/react";
import { useTicketTime } from "@/app/_components/products/ticket-time";

// next-intl's formatter is Intl.DateTimeFormat with the locale and the options
// it is given; here it is exactly that, with the real ICU data and no mock of
// the result. A ticket time must read as its own wall clock in its own offset
// whatever zone this machine is in (this file also runs under TZ=...).
jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({
      dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", options).format(value),
    }),
  };
});

function Shown({ value }: { value: string | null }) {
  const time = useTicketTime();
  return <p>{time(value) ?? "none"}</p>;
}

const shown = (value: string | null) => {
  const view = render(<Shown value={value} />);
  const text = screen.getByRole("paragraph").textContent;
  view.unmount();
  return text;
};

it("shows a ticket time as the issuer wrote it, in its own offset, on any machine", () => {
  expect(shown("2026-10-20T17:30+11:00")).toBe(
    "Tuesday, October 20, 2026 at 5:30 PM (UTC+11:00)",
  );
  expect(shown("2026-10-20T20:30+11:00")).toBe(
    "Tuesday, October 20, 2026 at 8:30 PM (UTC+11:00)",
  );
  // The same instant written in another offset keeps that offset's wall clock.
  expect(shown("2026-10-20T06:30Z")).toBe(
    "Tuesday, October 20, 2026 at 6:30 AM (UTC)",
  );
  expect(shown("2026-10-19T23:30-07:00")).toBe(
    "Monday, October 19, 2026 at 11:30 PM (UTC-07:00)",
  );
  // Seconds, when written, are not shown and do not move the minute.
  expect(shown("2026-11-20T19:30:59Z")).toBe(
    "Friday, November 20, 2026 at 7:30 PM (UTC)",
  );
  // Not a ticket time: nothing is shown, never a guess.
  for (const value of [null, "2026-10-20T17:30", "2026-02-30T17:30+11:00"]) {
    expect(shown(value)).toBe("none");
  }
});
