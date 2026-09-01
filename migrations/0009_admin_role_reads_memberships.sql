-- ═══════════════════════════════════════════════════════════════════════════
-- core_api_admin needs to READ core.memberships.
--
-- The administration surface (Section 3.1a) invalidates cached permissions for
-- every membership affected when a role's permission set changes — the same
-- "grant must take effect at once" rule Section 6.3 states for revocation.
-- Finding which memberships hold a role, org-wide or app-scoped, means
-- reading core.memberships, which core_api_admin had no grant on at all;
-- only core_api_rw did.
--
-- SELECT only. core_api_admin still cannot write to core.memberships —
-- membership itself stays a synchronized projection of Clerk (Section 4.6),
-- never something the administration surface creates directly.
-- ═══════════════════════════════════════════════════════════════════════════

GRANT SELECT ON core.memberships TO core_api_admin;
