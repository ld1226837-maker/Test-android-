# Booking scenarios — test plan (Android, 6 AM → 6 AM business day)

Automated: `src/lib/booking-scenarios.test.ts` (+ `slot-selection.test.ts`, `courts.test.ts`).
Run: `npx vitest run src/lib/booking-scenarios.test.ts`

## Rules under test
- Minutes are business-day minutes: 6 AM = 360, 12 AM = 1440, 6 AM next = 1800.
- A booking STARTS between 6 AM and 5:30 AM next morning; it may END up to 9 AM next morning (1980).
- One booking never exceeds 24 h (`MAX_SPAN`).
- Ends are exclusive: ending where another booking starts is allowed.
- Occupancy is absolute across dates, so a booking that runs past 6 AM also blocks the next date's morning.

## Scenario matrix
| ID | Scenario | Expected | Automated |
|----|----------|----------|-----------|
| S1 | Same-day 2 h, 30-min grid, back-to-back, range swallowing a booked slot | Allowed / refused as stated | S1 |
| S2 | Full business day 6 AM → 6 AM | Allowed, 24 h (24 slots, 48 on 30-min) | S2 |
| S2 | 6 AM → 7 AM next morning (25 h) | Refused | S2 |
| S2 | 7 AM → 7 AM next day (24 h) allowed, +1 slot refused | As stated | S2 |
| S2 | Any one booked hour inside a 24 h range | Range refused | S2 |
| S2 | Every hour can start a 1 h booking; 6 AM next morning cannot start | As stated | S2 |
| S3 | 11 PM → 1 AM, 10 PM → 3 AM, 12 AM → 6 AM | One booking, one business date, clock labels | S3 |
| S4 | 5 AM → 7 AM (60-min) and 4:30 → 6:30 AM (30-min) | Allowed | S4 |
| S4 | 11 PM → 9 AM allowed; → 9:30 AM refused | Cap at 9 AM | S4 |
| S4 | Next-morning slot booked inside the range / as the end | Refused / allowed | S4 |
| S5 | Edit round-trip: 5→7 AM, 11 PM→1 AM, 10 PM→12 AM, 6 AM→6 AM, 12→6 AM | Same labels and minutes back | S5 |
| S6 | Date D 10 PM–2 AM vs date D+1 morning | No clash | S6 |
| S6 | Date D 5–7 AM vs D+1 6–7 AM / 7–8 AM | Clash / no clash | S6 |
| S6 | Full 24 h on D | Blocks all of D, none of D+1 | S6 |
| S6 | D ends 7 AM, D+1 starts 7 AM | Both fit | S6 |
| S6 | 2 courts, 5–7 AM on c1 | 2-court refused, 1-court gets c2 | S6 |
| S6 | Editing a booking ignores itself | Own slots free | S6 |
| S7 | Utilisation segments: 5–7 AM splits at the seam; 10 PM–2 AM one date; 24 h = 1440 min | As stated | S7 |

## Manual checks on a device (not automated)
1. Late Night tab: tap 5 AM, then "End at 7 AM" → summary reads 5 AM – 7 AM · 2 hr.
2. Save, reopen via Edit → same selection; calendar and receipt show 5 AM – 7 AM.
3. Next date, Morning tab: 6 AM slot shows booked; 7 AM free.
4. Book 6 AM next date first, then try 5–7 AM on the earlier date → "End at 7 AM" disabled.
5. 30-min interval: repeat 4:30 → 6:30 AM.
6. Weekly repeat of a 5–7 AM booking: each week saves and none clash.
7. Utilisation card and Dashboard "upcoming" list show the booking once.
8. Payment/advance, cancel, No-show on a cross-seam booking behave like any other.

## Known gaps
- Pricing of a booking that straddles two day-part rates uses the rate chosen for the booking, not a per-hour split.
- UI is covered by the manual list only; no component tests.
