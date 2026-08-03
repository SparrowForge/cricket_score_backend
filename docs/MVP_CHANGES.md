# MVP Scoring Formula Update

## Changes Made

### 1. Added Contribution Point for Batsmen

**New Component**: `runs_scored / overs_per_innings`

Measures each batter's share of the team's run total relative to match length. This rewards players who significantly contribute to the team's batting effort.

**Formula**: 
- T20 (20 overs): 20 runs → 1.0 point, 40 runs → 2.0 points
- ODI (50 overs): 50 runs → 1.0 point, 100 runs → 2.0 points

**Impact**: 
- Uncapped contribution acknowledges significant batting contributions
- Works across all formats fairly (same proportion, same points)
- Complements other batting metrics (runs, boundaries, milestones, pace)

### 2. Format-Dependent Batting Milestones

**Old Formula** (absolute overs):
- 10 × O → +16 points
- 8 × O → +12 points
- 6 × O → +8 points
- 4 × O → +4 points

**New Formula** (format-dependent):

#### For 1-20 over matches:
- 3 × O → +16 points
- 2.5 × O → +12 points
- 2 × O → +8 points
- 1.5 × O → +4 points

#### For 21+ over matches:
- 2 × O → +16 points
- 1.6 × O → +12 points
- 1.4 × O → +8 points
- 1 × O → +4 points

**Impact**: This makes the milestones more challenging in longer formats while keeping them comparable in shorter formats. A 30 in a 5-over game is still recognized as significant.

### 2. Removed +2 Winning Team Bonus

**Old Formula**:
- Every participating player on winning team: +2 points

**New Formula**:
- Removed entirely
- Winning team now receives only 1.1× multiplier on base score (already existed)

**Impact**: This eliminates the double bonus (both +2 flat AND 1.1× multiplier). Total MVP points for winners are now lower, but the multiplier still rewards them appropriately.

### 3. Player of the Match Bonus

**Unchanged**: +3 points (still applied after performance calculation and subject to 1.1× multiplier for winning team)

## Migration Instructions

### Step 1: Deploy Code Changes

1. Build and deploy the backend:
   ```bash
   cd backend
   npm run build
   # Deploy to production
   ```

2. The new calculation will apply to all future matches automatically.

### Step 2: Recalculate Historical Matches

To recalculate MVP points for all previously completed matches, run:

```bash
cd backend
node scripts/recalculate-mvp.js
```

This script will:
- Fetch all completed matches
- Recalculate MVP points using the new formula
- Update tournament stats and career stats
- Take approximately 1-2 minutes depending on number of matches

**Example output**:
```
Fetching all completed matches...
Found 157 completed matches

[1/157] ✓ Recalculated MVP for match 26584134-f7bf-4917-9452-846c433782c1
[2/157] ✓ Recalculated MVP for match 3a8c2d9f-5e3c-4b2d-a1f1-2b9c8d5a3e4f
...
✓ Recalculation complete for all 157 matches
```

### Step 3: Verify Results

Check MVP leaderboards in the application to ensure:
- Points are lower overall (removal of +2 bonus)
- Top performers still rank correctly
- Format-dependent milestones are being applied

## Data Consistency

- `player_match_stats.mvp_points` — Updated with new calculations
- `match_mvp_points` — Rebuilt with new components
- `player_tournament_stats.mvp_points` — Recalculated from all matches
- `player_career_stats` — Not affected (only stores individual match runs/wickets, not MVP)
- `matches.player_of_match_id` — Re-selected if not manually set

## Rollback

If you need to revert to the old formula:

1. Revert the code changes in `stats.service.ts`
2. Run the recalculation script again with the old formula
3. The script is idempotent, so it can be run multiple times safely

## Testing

Test the new formula with a few completed matches:

```bash
# From backend directory with npm/node:
curl -X POST http://localhost:3001/api/v1/matches/{matchId}/recalculate-mvp \
  -H "Authorization: Bearer {admin_token}"
```

This triggers `StatsService.recalculateMvp()` for a single match.

## Timing

Recalculation should be done during low-traffic periods as it:
- Locks specific matches for read-only access during calculation
- Updates tournament and career stats
- Can impact database performance for 1-2 minutes

## Questions

Refer to `docs/MVP_SCORING.md` for detailed formula documentation with examples.
