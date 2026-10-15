"""Canonical registered referral cohort, independent of award qualification.

Relationships are unique per referred identity. The bound attribution proves
signup; a link opening alone can never enter this cohort. Expired qualification
windows do not undo a real signup; rejected or revoked attribution does.
"""

JOINED_REFERRAL_PREDICATE = """
 r.referrer_user_id <> r.referred_user_id
 AND r.status NOT IN ('rejected', 'revoked', 'ineligible')
 AND EXISTS (SELECT 1 FROM actor_profiles p WHERE p.user_id=r.referred_user_id)
 AND EXISTS (SELECT 1 FROM one_referral_attributions a
   WHERE a.id=r.attribution_id AND a.referrer_user_id=r.referrer_user_id
     AND a.bound_user_id=r.referred_user_id AND a.status='bound')
"""
