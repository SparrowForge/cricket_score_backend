-- ============================================================
-- Migration 17: Enrich home page content with more features
-- ============================================================

UPDATE cms_pages
SET blocks = '[
  {
    "id": "hero",
    "type": "hero",
    "props": {
      "heading": "Professional Cricket Scoring Made Simple",
      "subheading": "Real-time ball-by-ball scoring, live stats, and professional scorecards for clubs, schools, and leagues across Bangladesh.",
      "cta": {"label": "Start free", "href": "/register"},
      "secondary_cta": {"label": "View pricing", "href": "/pricing"}
    }
  },
  {
    "id": "features",
    "type": "feature_grid",
    "props": {
      "columns": 3,
      "items": [
        {
          "icon": "radio",
          "title": "Real-time Updates",
          "body": "Sub-second ball-by-ball updates. Share live scores with fans instantly."
        },
        {
          "icon": "bar-chart",
          "title": "Professional Stats",
          "body": "Wagon wheels, partnership graphs, career records, and detailed player statistics."
        },
        {
          "icon": "settings",
          "title": "Any Format",
          "body": "T20, ODI, Test, T10, Sixes, or create your own custom format rules."
        },
        {
          "icon": "trophy",
          "title": "Tournament Management",
          "body": "Schedule, organize and manage multiple tournaments and leagues simultaneously."
        },
        {
          "icon": "users",
          "title": "Team Management",
          "body": "Manage players, build squads, track performance across your organization."
        },
        {
          "icon": "shield",
          "title": "Secure & Reliable",
          "body": "Enterprise-grade security with automatic backups and 99.9% uptime."
        }
      ]
    }
  },
  {
    "id": "pricing_preview",
    "type": "pricing_table",
    "props": {
      "plan_slugs": ["free", "club", "league"]
    }
  },
  {
    "id": "cta",
    "type": "cta_banner",
    "props": {
      "heading": "Join hundreds of cricket organizations using CricLive",
      "subheading": "Get started for free, no credit card required. Upgrade anytime as your league grows.",
      "cta": {"label": "Create your first tournament", "href": "/register"}
    }
  }
]'
WHERE slug = 'home';

-- Also update the pricing page to show all plans with comparison
UPDATE cms_pages
SET blocks = '[
  {
    "id": "pricing_hero",
    "type": "hero",
    "props": {
      "heading": "Simple, Transparent Pricing",
      "subheading": "Start free and scale as your cricket operations grow. No hidden fees, cancel anytime."
    }
  },
  {
    "id": "plans",
    "type": "pricing_table",
    "props": {
      "plan_slugs": ["free", "club", "league", "pro"],
      "show_comparison": true
    }
  }
]'
WHERE slug = 'pricing';
