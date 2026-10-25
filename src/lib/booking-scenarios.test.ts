/**
 * Booking SCENARIO matrix (see docs/BOOKING-SCENARIOS-TEST-PLAN.md).
 * Business-day minutes: 6 AM = 360 … 12 AM = 1440 … 6 AM next = 1800.
 * A booking STARTS before 6 AM next morning, may END up to 9 AM (1980), and
 * never exceeds 24 h.
 */
import { describe, expect, it } from "vitest";
import {
  canEndAt,
  DAY_END,
  MAX_END,
  MIDNIGHT,
  nextSelection,
  slotsForSpan,
  spanFromTimes,
} from "./slot-selection";
import {
  assignCourts,
  buildCourtOccupancy,
  courtHourSegments,
  freeCourtIdsFor,
} from "./courts";
import { minuteLabel, parseMinutes } from "./time-slot-utils";

const H = (h: number, m = 0) => h * 60 + m;
const set = (...n: number[]) => new Set(n);
const taps = (t: number[], iv: number, booked: Set<number> = set()) =>
  t.reduce<number[]>((sel, m) => nextSelection(sel, m, iv, booked), []);
const hrs = (sel: number[], iv: number) => (sel.length * iv) / 60;

type B = {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  hours: number;
  courts: number;
  court_ids: string[];
};
const bk = (
  id: string,
  date: string,
  start: string,
  end: string,
  hours: number,
  court_ids = ["c1"],
): B => ({
  id,
  booking_date: date,
  start_time: start,
  end_time: end,
  hours,
  courts: court_ids.length,
  court_ids,
});

describe("S1 same-day bookings", () => {
  it("morning 6–8 AM, evening 6–8 PM, 30-min 6:30–7:30 PM", () => {
    expect(hrs(taps([H(6), H(8)], 60), 60)).toBe(2);
    expect(hrs(taps([H(18), H(20)], 60), 60)).toBe(2);
    expect(taps([H(18, 30), H(19, 30)], 30)).toEqual([H(18, 30), H(19)]);
  });
  it("back-to-back: end exactly where a booked slot starts is allowed", () => {
    expect(taps([H(17), H(18)], 60, set(H(18)))).toEqual([H(17)]);
    expect(taps([H(17), H(19)], 60, set(H(18)))).toEqual([H(17)]); // swallows 6 PM → refused
  });
});

describe("S2 24-hour checks", () => {
  it("full business day 6 AM → 6 AM next morning = 24 h (24 / 48 slots)", () => {
    expect(hrs(taps([H(6), DAY_END], 60), 60)).toBe(24);
    expect(taps([H(6), DAY_END], 30)).toHaveLength(48);
  });
  it("25 h is refused: 6 AM → 7 AM next morning", () => {
    expect(canEndAt([H(6)], DAY_END + 60, 60, set())).toBe(false);
    expect(taps([H(6), DAY_END + 60], 60)).toEqual([H(6)]);
  });
  it("24 h from 7 AM ends 7 AM next morning (allowed); 24 h + 1 slot refused", () => {
    expect(canEndAt([H(7)], H(7) + 1440, 60, set())).toBe(true);
    expect(canEndAt([H(7)], H(7) + 1440 + 60, 60, set())).toBe(false);
  });
  it("any single booked hour inside a 24 h range blocks it", () => {
    for (const h of [6, 12, 23, 24 + 3, 24 + 5]) {
      const booked = set(h * 60);
      const sel = taps([H(6), DAY_END], 60, booked);
      expect(sel).not.toContain(h * 60);
      expect(sel.length).toBeLessThan(24);
    }
  });
  it("every hour of the 24 h can START a 1 h booking, except 6 AM next morning", () => {
    for (let m = H(6); m < DAY_END; m += 60)
      expect(taps([m, m + 60], 60)).toEqual([m]);
    expect(taps([DAY_END], 60)).toEqual([]);
  });
});

describe("S3 cross-midnight (same business date)", () => {
  it("11 PM → 1 AM, 10 PM → 3 AM, 12 AM → 6 AM", () => {
    expect(hrs(taps([H(23), MIDNIGHT + 60], 60), 60)).toBe(2);
    expect(hrs(taps([H(22), MIDNIGHT + 180], 60), 60)).toBe(5);
    expect(hrs(taps([MIDNIGHT, DAY_END], 60), 60)).toBe(6);
  });
  it("labels come out as clock times", () => {
    const sel = taps([H(22), MIDNIGHT + 120], 60);
    expect(minuteLabel(sel[0]!)).toBe("10 PM");
    expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe("2 AM");
  });
});

describe("S4 cross the 6 AM seam (cross-day)", () => {
  it("5 AM → 7 AM (60) and 4:30 → 6:30 AM (30)", () => {
    expect(hrs(taps([MIDNIGHT + H(5), DAY_END + 60], 60), 60)).toBe(2);
    const s = taps([MIDNIGHT + H(4, 30), DAY_END + 30], 30);
    expect(s).toHaveLength(4);
    expect(minuteLabel(s[s.length - 1]! + 30, true)).toBe("6:30 AM");
  });
  it("11 PM → 9 AM (10 h) allowed, 11 PM → 9:30 AM refused", () => {
    expect(canEndAt([H(23)], MAX_END, 60, set())).toBe(true);
    expect(canEndAt([H(23)], MAX_END + 30, 30, set())).toBe(false);
  });
  it("next-morning slot booked inside the range blocks it; as the end it is fine", () => {
    const b = set(DAY_END);
    expect(taps([MIDNIGHT + H(5), DAY_END + 60], 60, b)).toEqual([
      MIDNIGHT + H(5),
    ]);
    expect(taps([MIDNIGHT + H(5), DAY_END], 60, b)).toEqual([MIDNIGHT + H(5)]);
  });
});

describe("S5 edit round-trip (stored strings → selection → strings)", () => {
  const cases: [string, string, number][] = [
    ["5 AM", "7 AM", 120],
    ["11 PM", "1 AM", 120],
    ["10 PM", "12 AM", 120],
    ["6 AM", "6 AM", 1440], // full 24 h
    ["12 AM", "6 AM", 360],
  ];
  for (const [st, en, span] of cases)
    it(`${st} → ${en} = ${span} min`, () => {
      const s = parseMinutes(st)!;
      const e = parseMinutes(en)!;
      expect(spanFromTimes(s, e, span / 60)).toBe(span);
      const biz = s < 360 ? s + 1440 : s;
      const sel = slotsForSpan(biz, span, 60);
      expect(minuteLabel(sel[0]!)).toBe(st);
      expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe(en);
    });
});

describe("S6 cross-day occupancy between dates", () => {
  const D = "2026-10-10";
  const N = "2026-10-11";
  const free = (
    occ: ReturnType<typeof buildCourtOccupancy>,
    start: number,
    min: number,
  ) => assignCourts(occ, 1, start, min, 1);

  it("D 10 PM–2 AM sits at 1320–1560 on D and does not touch D+1's 6 AM", () => {
    const b = bk("a", D, "10 PM", "2 AM", 4);
    expect(free(buildCourtOccupancy([b], D, 1), H(22), 240)).toBeNull();
    expect(free(buildCourtOccupancy([b], N, 1), H(6), 60)).toEqual(["c1"]);
  });
  it("D 5–7 AM blocks D+1 6–7 AM but not 7–8 AM", () => {
    const b = bk("a", D, "5 AM", "7 AM", 2);
    const onN = buildCourtOccupancy([b], N, 1);
    expect(free(onN, H(6), 60)).toBeNull();
    expect(free(onN, H(7), 60)).toEqual(["c1"]);
  });
  it("full 24 h (6 AM → 6 AM) blocks all of D and nothing of D+1", () => {
    const b = bk("a", D, "6 AM", "6 AM", 24);
    expect(free(buildCourtOccupancy([b], D, 1), H(6), 60)).toBeNull();
    expect(free(buildCourtOccupancy([b], D, 1), DAY_END - 60, 60)).toBeNull();
    expect(free(buildCourtOccupancy([b], N, 1), H(6), 60)).toEqual(["c1"]);
  });
  it("back-to-back across dates: D ends 7 AM, D+1 starts 7 AM → both fit", () => {
    const a = bk("a", D, "5 AM", "7 AM", 2);
    const occ = buildCourtOccupancy([a], N, 1);
    expect(free(occ, H(7), 120)).toEqual(["c1"]);
  });
  it("2 courts: 5–7 AM on c1, a second 2-court booking over 6–7 AM is refused, 1-court fits", () => {
    const a = bk("a", D, "5 AM", "7 AM", 2, ["c1"]);
    const occ = buildCourtOccupancy([a], N, 2);
    expect(assignCourts(occ, 2, H(6), 60, 2)).toBeNull();
    expect(assignCourts(occ, 2, H(6), 60, 1)).toEqual(["c2"]);
    expect(freeCourtIdsFor(occ, 2, H(7), 60)).toEqual(["c1", "c2"]);
  });
  it("cancelled-style removal: excludeId frees the booking's own slots (edit)", () => {
    const a = bk("a", D, "5 AM", "7 AM", 2);
    const occ = buildCourtOccupancy([a], D, 1, "a");
    expect(free(occ, MIDNIGHT + H(5), 120)).toEqual(["c1"]);
  });
});

describe("S7 utilisation segments", () => {
  const seg = (s: string, e: string, h: number) =>
    courtHourSegments({ ...bk("x", "2026-10-10", s, e, h) });
  it("5–7 AM splits 5–6 AM (this date) and 6–7 AM (next date)", () => {
    expect(seg("5 AM", "7 AM", 2)).toEqual([
      { dayOffset: 0, from: 1740, to: 1800, n: 1 },
      { dayOffset: 1, from: 360, to: 420, n: 1 },
    ]);
  });
  it("10 PM–2 AM stays on one business date", () => {
    expect(seg("10 PM", "2 AM", 4)).toEqual([
      { dayOffset: 0, from: 1320, to: 1560, n: 1 },
    ]);
  });
  it("6 AM → 6 AM covers exactly 1440 minutes on one date", () => {
    const [s] = seg("6 AM", "6 AM", 24);
    expect(s!.to - s!.from).toBe(1440);
  });
});
