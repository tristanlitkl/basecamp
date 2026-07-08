# Ledger Invariants

Basecamp expense data uses integer cents only.

Ledger entries are immutable and append-only. Corrections are represented as reversal entries, and balances are computed from ledger sums rather than mutable balance columns.
