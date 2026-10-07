"""Referral gamification scoring rules.

Pure functions only. Nothing here reads a database, a clock or a request --
the service layer (`hushh_mcp.services.one_referral_scoring_service`) owns all
I/O and calls these with values it already fetched. That split is what makes
"a referral qualified during a flash window is worth 200 points" and "a
three-day streak is awarded exactly once" testable without a database.
"""
