# Persisted collaboration notifications

Notifications are retained indefinitely in Postgres and are authoritative per
recipient. WebSocket plan events only cause normal client invalidation; they
are never used as notification storage or delivery acknowledgement.

Each source mutation writes its plan event and required notification rows in
the same transaction, before commit. `recipient_user_id + source_key` is
unique, so idempotent mutation replays cannot duplicate a notification.
Read-state updates do not write plan events and never change either plan
version counter.

## Recipient rules

| Source event | Recipients |
| --- | --- |
| Member joins | Current members other than the joining member |
| Promotion, demotion, removal | The affected member only |
| Co-owner request created | Primary owner and co-owners, excluding requester |
| Co-owner request accepted/rejected | Requester only |
| Activity/date/plan suggestion accepted or dismissed | Original suggester only |
| Plan finalized or reopened | Current members other than the actor |
| Itinerary added, material schedule change, or removal | Current members other than the actor |
| Expense added, corrected, or reversed | Expense participants and payer, excluding actor |

There are intentionally no vote notifications. This avoids voter-identity
disclosure when a plan uses anonymous voting.

The notification stores concise text and source metadata, not snapshots or
live references. A deleted itinerary item, removed membership, or reversed
expense therefore still renders safely.
