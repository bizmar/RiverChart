# Alert backtest

Made by `scripts/backtest.py` from the daily record, 2015-01-01 to 2026-01-19 (11.0 years with Zalog well data and both rivers).

**Events**: Zalog groundwater within 0.40 m of the reference level (266.38 m, 2023-11-06), i.e. at or above 265.98 m:

- 2017-12-13 to 2017-12-14: peak 266.36 m on 2017-12-13
- 2023-08-05 to 2023-08-07: peak 266.96 m on 2023-08-06
- 2023-11-04 to 2023-11-07: peak 266.38 m on 2023-11-06

A rule *catches* an event when it is on at some point from 10 days before the event to its last day. *Lead* is how many days before the event it turned on. A *false* alert has no event in the 10 days after it.

## Ljubljanica high (Moste I, daily mean level)

| On at | Clears at | Alerts | Per year | Caught | Lead (days) | False |
|---|---|---|---|---|---|---|
| 180 cm | 160 cm | 59 | 5.3 | 3 of 3 | 4, 1, 8 | 56 |
| 200 cm **(now)** | 180 cm | 42 | 3.8 | 3 of 3 | 4, 0, 7 | 38 |
| 220 cm | 200 cm | 20 | 1.8 | 2 of 3 | 4, 0 | 18 |
| 240 cm | 220 cm | 6 | 0.5 | 2 of 3 | 1, 0 | 4 |
| 260 cm | 240 cm | 0 | 0.0 | 0 of 3 | – | 0 |

## Zalog estimate near the reference (estimated from the rivers, each year unseen by its fit)

| On at | Clears at | Alerts | Per year | Caught | Lead (days) | False |
|---|---|---|---|---|---|---|
| 0.3 m below | 0.5 m below | 3 | 0.3 | 3 of 3 | 0, 0, 1 | 0 |
| 0.5 m below | 0.7 m below | 4 | 0.4 | 3 of 3 | 0, 0, 1 | 1 |
| 0.7 m below **(now)** | 0.9 m below | 5 | 0.5 | 3 of 3 | 1, 0, 7 | 2 |
| 0.9 m below | 1.1 m below | 7 | 0.6 | 3 of 3 | 1, 0, 7 | 4 |
| 1.1 m below | 1.3 m below | 11 | 1.0 | 3 of 3 | 1, 1, 8 | 8 |

## Heavy rain forecast (mm over today and the next 2 days, Ljubljanica and Sava catchments)

| On at | Clears at | Alerts | Per year | Caught | Lead (days) | False |
|---|---|---|---|---|---|---|
| 50 mm | 25 mm | 75 | 6.8 | 3 of 3 | 6, 3, 10 | 72 |
| 60 mm | 30 mm | 38 | 3.4 | 3 of 3 | 5, 2, 10 | 34 |
| 70 mm **(now)** | 35 mm | 25 | 2.3 | 3 of 3 | 3, 2, 10 | 21 |
| 80 mm | 40 mm | 15 | 1.4 | 2 of 3 | 3, 2 | 13 |
| 90 mm | 45 mm | 11 | 1.0 | 0 of 3 | – | 11 |

