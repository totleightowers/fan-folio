# OTP filtering

Library → Filters → Relationships → **OTP · One relationship only** shows works
with exactly one saved relationship tag. It works without selecting a pairing,
or alongside the existing include/exclude filters. Zero relationship tags do
not match; a single platonic or multi-person relationship tag does match.

The control remains available when there are no relationship facet results or
when a chosen tag is outside the forty most common tags. It keeps the existing
saved `otp` preference, appears in the active filters, and clears with the other
filters.

AO3 documents `otp: true` as one relationship, usable on its own or together
with a chosen relationship. AO3 also counts synonymous tags mapped to the same
canonical relationship as one. Source: [Hidden search operators cheatsheet](https://archiveofourown.org/admin_posts/10851).

Fan Folio's offline library stores tag names, not AO3 canonical identities or
synonym mappings. It therefore counts distinct saved relationship names. It can
exclude a work that AO3 would include when several names are synonyms. The filter
explains this limitation, and does not guess equivalence or request tag pages.

Previously, “Only this pairing” only appeared after selecting a relationship
present in the capped facet results. Its query allowed any number of included
relationships and did nothing with no included tags. The restored control uses
one-relationship semantics in both the JavaScript and Dart query builders.

Validation includes SQLite cases for zero, one and multiple relationship tags;
combining OTP with fandom, relationship inclusion and exclusion; platonic and
multi-person relationships; and the browser journey for discovery before tag
selection, saved settings after reload and removal with empty facet results.
