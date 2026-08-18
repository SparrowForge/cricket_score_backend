-- ============================================================
-- Migration 24: Home page rewrite — fuller feature coverage,
--               new block types, and honest claims
-- ============================================================
-- Supersedes the content set by migrations 17 and 19.
--
-- Two kinds of change here.
--
-- 1. MORE INFORMATION. The old page listed six features and stopped. It never
--    mentioned the things that actually make this product different from a
--    scoring spreadsheet: offline-first scoring, undo/corrections over an
--    append-only ball log, the MVP model, or the Android app. Those are now
--    covered, along with new stat/steps/format/split bands.
--
-- 2. CLAIMS THAT WERE NOT TRUE. The previous copy said:
--
--      "Join hundreds of cricket organizations using CricLive"
--      "Enterprise-grade security with automatic backups and 99.9% uptime"
--      "Sub-second ball-by-ball updates"
--
--    At the time of writing the database holds ONE organization. There is no
--    uptime SLA and no automated backup product — the app runs on cPanel shared
--    hosting. And no latency budget is measured anywhere, so "sub-second" was a
--    number nobody could defend.
--
--    All three are gone. Nothing on this page now claims a user count, an
--    uptime figure, or a latency number. The stat band deliberately carries
--    CAPABILITY facts (formats supported, price, platforms) rather than usage
--    totals, because the usage totals are small and inflating them is how the
--    old copy got into trouble.
--
-- NOTE ON ORDERING: the feature list mentions Gully (rotation) mode, which
-- ships in migration 23 + the rotation service. Apply this only once that build
-- is deployed, or the page advertises a mode the API does not yet serve.

UPDATE cms_pages
SET title = 'CricLive — Ball-by-ball cricket scoring that works offline',
    blocks = '[
  {
    "id": "hero",
    "type": "hero",
    "props": {
      "eyebrow": "Live ball-by-ball scoring",
      "heading": "Score every ball. Even with no signal.",
      "subheading": "CricLive is a ball-by-ball scoring platform for clubs, schools and leagues. Keep scoring when the mobile network drops out at the ground — every delivery is saved on your device and syncs the moment you are back online.",
      "cta": {"label": "Start free", "href": "/register"},
      "secondary_cta": {"label": "Watch live matches", "href": "/matches"},
      "bullets": [
        "No credit card to start",
        "Web and Android",
        "Your data stays yours"
      ]
    }
  },
  {
    "id": "stats",
    "type": "stat_band",
    "props": {
      "items": [
        {"label": "Formats built in", "value": "8", "note": "including your own custom rules"},
        {"label": "Cost to start", "value": "Free", "note": "upgrade only when you outgrow it"},
        {"label": "Runs on", "value": "Web + Android", "note": "one account, same live data"},
        {"label": "Signal needed", "value": "None", "note": "score offline, sync later"}
      ]
    }
  },
  {
    "id": "features",
    "type": "feature_grid",
    "props": {
      "eyebrow": "Everything in the box",
      "heading": "Built for the way cricket is actually scored",
      "blurb": "One scorer, one phone, and a match that has to be recorded correctly the first time.",
      "columns": 3,
      "items": [
        {
          "icon": "wifi_off",
          "title": "Offline-first scoring",
          "body": "Every ball goes into a queue on your device first. Lose signal mid-over and scoring carries on — nothing is lost, and the queue syncs in order when the connection returns."
        },
        {
          "icon": "radio",
          "title": "Live for everyone watching",
          "body": "Scores push straight to anyone following the match — no refreshing. Share one link and family, fans and the other team can all follow ball by ball."
        },
        {
          "icon": "undo",
          "title": "Undo and fix mistakes",
          "body": "Balls are never overwritten. Mis-scored a delivery three overs ago? Correct it, and the scorecard, over summaries and commentary are rebuilt from the record."
        },
        {
          "icon": "settings",
          "title": "Every format, or your own",
          "body": "T20, ODI, Test, T10, The Hundred, 6-a-side and Gully mode ship built in. Change overs, wickets, bowler limits or no-ball rules and the engine follows."
        },
        {
          "icon": "bar-chart",
          "title": "Real analysis, not just totals",
          "body": "Wagon wheels, Manhattan and worm charts, partnerships, strike rates, economy and full career records for every player."
        },
        {
          "icon": "trophy",
          "title": "Run a whole tournament",
          "body": "Generate fixtures, track the points table, and keep leaderboards for runs and wickets updated automatically as matches finish."
        },
        {
          "icon": "target",
          "title": "Player of the match, settled fairly",
          "body": "MVP points weigh batting, bowling and fielding together — including dot balls, catches and how set the dismissed batter was — so the award is not just whoever scored most."
        },
        {
          "icon": "users",
          "title": "Squads and player profiles",
          "body": "Build squads, manage playing XIs and substitutions, and give every player a profile with their full match history."
        },
        {
          "icon": "phone",
          "title": "Score from the phone in your pocket",
          "body": "The Android app and the web console score the same match against the same data. Start on one, finish on the other."
        }
      ]
    }
  },
  {
    "id": "offline",
    "type": "split_feature",
    "props": {
      "eyebrow": "Why offline matters",
      "heading": "Grounds have bad signal. Scoring should not care.",
      "blurb": "Most scoring apps assume a working connection and freeze without one. CricLive treats the network as optional — the scorer''s device is the source of truth until the server can catch up.",
      "cta": {"label": "See how scoring works", "href": "/register"},
      "points": [
        {
          "icon": "wifi_off",
          "title": "Keeps taking deliveries at zero bars",
          "body": "The score, the over and the strike all update instantly from your device, not from a server round trip."
        },
        {
          "icon": "undo",
          "title": "Nothing is scored twice",
          "body": "Each ball carries its own id, so a retry after a dropped connection is recognised rather than double-counted."
        },
        {
          "icon": "shield",
          "title": "Rules checked before it queues",
          "body": "An illegal delivery is caught as you tap it, while you still remember the ball — not an over later when the queue tries to sync."
        }
      ]
    }
  },
  {
    "id": "how",
    "type": "steps",
    "props": {
      "eyebrow": "Getting started",
      "heading": "First match scored in a few minutes",
      "items": [
        {"title": "Add your players", "body": "Create your club and add the players. Quick-add works mid-match if someone turns up late."},
        {"title": "Pick the format", "body": "Choose T20, The Hundred, Gully or set your own overs, wickets and bowler limits."},
        {"title": "Score ball by ball", "body": "Tap runs, extras and wickets. Wagon wheel and commentary are optional as you go."},
        {"title": "Share the link", "body": "Anyone with the link follows live, and the full scorecard stays online afterwards."}
      ]
    }
  },
  {
    "id": "formats",
    "type": "format_band",
    "props": {
      "eyebrow": "Formats",
      "heading": "From a Test match to a game in the street",
      "items": ["T20", "ODI (50 overs)", "Test (2 innings)", "T10", "The Hundred", "6-a-side Sixes", "Gully (rotation)", "Custom rules"],
      "footnote": "Gully mode is for pickup cricket: no teams, one batter at a time, everyone bats and bowls in turn, and everyone gets their own stats."
    }
  },
  {
    "id": "pricing_preview",
    "type": "pricing_table",
    "props": {
      "eyebrow": "Pricing",
      "heading": "Start free, pay only when you outgrow it",
      "blurb": "The free plan scores real matches with no time limit. Paid plans add more teams, tournaments and concurrent matches.",
      "plan_slugs": ["free", "club", "league"]
    }
  },
  {
    "id": "faq",
    "type": "faq",
    "props": {
      "eyebrow": "Questions",
      "heading": "Before you sign up",
      "items": [
        {
          "q": "What happens if I lose signal in the middle of an over?",
          "a": "Nothing stops. Scoring continues on your device and each ball is queued in order. When the connection returns the queue syncs by itself, and the live score catches up for everyone watching."
        },
        {
          "q": "Can I fix a ball I scored wrong?",
          "a": "Yes. Balls are stored as a record of events rather than a running total, so a correction re-derives the scorecard, over summaries, partnerships and commentary from the corrected record."
        },
        {
          "q": "Do I need to pay to score a real match?",
          "a": "No. The free plan scores full matches with live sharing and complete scorecards. You only need a paid plan for more teams, more tournaments, or several matches running at once."
        },
        {
          "q": "Can I use my own rules?",
          "a": "Yes. Overs per innings, wickets, balls per over, bowler limits, no-ball and free-hit behaviour and more are all configurable, and the scoring engine enforces whatever you set."
        },
        {
          "q": "Is there a mobile app?",
          "a": "There is an Android app, and the web console works on any modern browser. Both score the same match against the same data."
        },
        {
          "q": "Who owns the match data?",
          "a": "You do. Scorecards, player records and tournament history belong to your organization and stay available to you."
        }
      ]
    }
  },
  {
    "id": "cta",
    "type": "cta_banner",
    "props": {
      "heading": "Score your next match with CricLive",
      "subheading": "Create a club, add your players, and score a match today. Free to start, no credit card.",
      "cta": {"label": "Create your free account", "href": "/register"},
      "secondary_cta": {"label": "See a live match first", "href": "/matches"}
    }
  }
]'::jsonb
WHERE slug = 'home';
