# MVP Scoring System

## Overview

MVP (Man of the Match) points are calculated based on player performance in three streams: **batting**, **bowling**, and **fielding**. Each stream is calculated independently and can produce negative scores if a player underperforms. The final figure is multiplied by **1.1** for the winning team.

## Batting Points

Base points = runs scored + boundary bonus + format-dependent milestone + pace bonus + contribution point

### Components

| Component | Formula | Points |
|---|---|---|
| **Runs** | each run scored | +1 |
| **Boundaries** | fours × 0.5, sixes × 1 | Variable |
| **Milestone** | format-dependent threshold | +4 to +16 |
| **Pace bonus** | vs match run rate | ±8 (capped) |
| **Contribution point** | runs_scored / overs_per_innings | Variable |

### Format-Dependent Milestones

Milestones scale with the innings length to reward comparative performance:

#### For 1-20 over matches (T20, T10, 5-over formats):
| Runs Reached | Bonus |
|---|---|
| 3 × O | +16 |
| 2.5 × O | +12 |
| 2 × O | +8 |
| 1.5 × O | +4 |

**Examples** (for 20-over match, O=20):
- 60 runs = +16 (3×20)
- 50 runs = +12 (2.5×20)
- 40 runs = +8 (2×20)
- 30 runs = +4 (1.5×20)

#### For 21-50 over matches (ODI, 30-over formats):
| Runs Reached | Bonus |
|---|---|
| 2 × O | +16 |
| 1.6 × O | +12 |
| 1.4 × O | +8 |
| 1 × O | +4 |

**Examples** (for 50-over match, O=50):
- 100 runs = +16 (2×50)
- 80 runs = +12 (1.6×50)
- 70 runs = +8 (1.4×50)
- 50 runs = +4 (1×50)

### Boundary Bonus
- Each 4: +0.5 points
- Each 6: +1 point

### Pace Bonus
- Calculated against match run rate (all runs / all legal balls × 6)
- Formula: `max(-8, min(8, (runs_scored - balls_faced × MRR / 6) × 0.5))`
- Rewards batters scoring above the match rate, penalizes crawls
- Capped at ±8

### Contribution Point
- Measures the batter's share of team's runs relative to match length
- Formula: `runs_scored / overs_per_innings`
- Rewards players who contribute significantly to team total
- Uncapped: reflects actual contribution ratio

**Examples**:
- T20 (20 overs): 20 runs = 1.0 point, 40 runs = 2.0 points, 60 runs = 3.0 points
- ODI (50 overs): 50 runs = 1.0 point, 100 runs = 2.0 points, 150 runs = 3.0 points

## Bowling Points

Base points = wickets × 6 + maidens × 4 + dot balls × 0.25 + haul bonus + victim value + economy bonus

### Haul Bonus
| Wickets | Bonus |
|---|---|
| 5+ | +14 |
| 4 | +10 |
| 3 | +6 |
| 2 | +3 |

### Victim Value
Credit for removing set batters. For each wicket:
- Value = min(victim_runs × 0.2, 4 points)
- Rewards bowlers for taking scalps of batters who've built an innings

### Economy Bonus
- Similar to pace bonus for batters
- Formula: `max(-8, min(8, (balls_bowled × MRR / 6 - runs_conceded) × 0.5))`
- Rewards tight bowling against the match rate

## Fielding Points

Base points = catches × 6 + stumpings × 8 + run-outs × 8 - errors

### Fielding Errors
- Dropped catches: -3 points each
- Missed run-outs: -2 points each
- Misfields: -1 point each

## Match Bonuses

### Player of the Match
- Flat +3 points (applied after performance calculation)
- Determined by highest combined score in batting + bowling + fielding
- Decided before the bonus is paid, so cannot influence the winner

### Winning Team Multiplier
- All points multiplied by **1.1** for winning team
- Includes the Player of the Match bonus
- Losing team multiplier: 1.0

## Calculation Example

### T20 Match: 150-run winning chase

**Batter A (40 runs, 25 balls, 4 fours, 6 sixes on winning team):**
- Base runs: 40
- Boundary bonus: 4×0.5 + 6×1 = 8
- Milestone: 40 ≥ 2×20? Yes → +8
- Pace bonus: (40 - 25 × 5.6 / 6) × 0.5 = 1.08
- Batting subtotal: 40 + 8 + 8 + 1.08 = 57.08
- Win multiplier: 57.08 × 1.1 = 62.79

**Bowler B (2 wickets, 18 dots, 3 maidens):**
- Wickets: 2 × 6 = 12
- Maidens: 3 × 4 = 12
- Dots: 18 × 0.25 = 4.5
- Haul bonus: 2 wickets → +3
- Economy bonus: (24 × 5.6 / 6 - 28) × 0.5 = -2.27
- Bowling subtotal: 12 + 12 + 4.5 + 3 - 2.27 = 29.23
- Win multiplier: 29.23 × 1.1 = 32.15

**Fielder C (2 catches):**
- Catches: 2 × 6 = 12
- Fielding subtotal: 12
- Win multiplier: 12 × 1.1 = 13.2

## Technical Notes

- All calculations use `numeric` type for precision before rounding to 2 decimal places
- Each stream keeps its own sign; negative contributions are never floored
- Only the final displayed figure is shown as 0 minimum
- Match run rate (MRR) handles edge case of zero legal balls with `CASE WHEN` logic
- Player of the Match is selected from performance only (before +3 bonus), then bonus is applied
- Recalculation is idempotent — re-running `buildMvpPoints` always produces the same result
