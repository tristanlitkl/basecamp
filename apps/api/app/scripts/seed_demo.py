"""Create one repeatable, deterministic local Basecamp demonstration plan."""

import asyncio
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from app.api.routes.expenses import ExpenseCreate, create_expense_rows
from app.db.base import AsyncSessionLocal
from app.models.activity import Activity
from app.models.itinerary import ItineraryItem
from app.models.plan import Plan, PlanDateAvailability, PlanMember
from app.models.user import User
from app.models.vote import ActivityVote
from app.services.recommendation_service import recompute_plan_scores

DEMO_PLAN_ID = UUID("11111111-1111-1111-1111-111111111111")
DEMO_USERS = (
    (UUID("10000000-0000-0000-0000-000000000001"), "demo-owner", "owner", "Avery Owner"),
    (UUID("10000000-0000-0000-0000-000000000002"), "demo-co-owner", "co_owner", "Casey Co-owner"),
    (UUID("10000000-0000-0000-0000-000000000003"), "demo-member", "member", "Morgan Member"),
)


async def seed_demo() -> str:
    async with AsyncSessionLocal() as session:
        existing = await session.get(Plan, DEMO_PLAN_ID)
        if existing is not None:
            return "Basecamp demo already exists; no changes made."

        users: dict[str, User] = {}
        for user_id, subject, _role, name in DEMO_USERS:
            user = await session.get(User, user_id)
            if user is None:
                user = User(
                    id=user_id,
                    auth_subject=subject,
                    email=f"{subject}@example.test",
                    display_name=name,
                )
                session.add(user)
            users[subject] = user
        await session.flush()

        owner = users["demo-owner"]
        plan = Plan(
            id=DEMO_PLAN_ID,
            owner_id=owner.id,
            title="Demo: Redwood Weekend",
            description="Deterministic local demo data; no external providers required.",
            budget_cents=36000,
            starts_on=datetime(2026, 9, 18, tzinfo=timezone.utc),
            ends_on=datetime(2026, 9, 20, tzinfo=timezone.utc),
        )
        session.add(plan)
        session.add_all(
            PlanMember(plan_id=DEMO_PLAN_ID, user_id=user.id, role=role)
            for user, (_id, _subject, role, _name) in zip(users.values(), DEMO_USERS, strict=True)
        )
        await session.flush()

        activities = [
            Activity(
                name="Trailhead breakfast",
                plan_id=DEMO_PLAN_ID,
                created_by_user_id=owner.id,
                estimated_cost_cents=4200,
                estimated_duration_minutes=60,
                tags=["food", "morning"],
            ),
            Activity(
                name="Redwood loop hike",
                plan_id=DEMO_PLAN_ID,
                created_by_user_id=users["demo-co-owner"].id,
                estimated_cost_cents=0,
                estimated_duration_minutes=180,
                tags=["outdoors"],
            ),
            Activity(
                name="Campfire dinner",
                plan_id=DEMO_PLAN_ID,
                created_by_user_id=users["demo-member"].id,
                estimated_cost_cents=15600,
                estimated_duration_minutes=120,
                tags=["food", "evening"],
            ),
        ]
        session.add_all(activities)
        await session.flush()
        session.add_all(
            [
                ActivityVote(activity_id=activities[0].id, user_id=owner.id, vote="yes"),
                ActivityVote(activity_id=activities[1].id, user_id=owner.id, vote="yes"),
                ActivityVote(
                    activity_id=activities[1].id, user_id=users["demo-co-owner"].id, vote="yes"
                ),
                ActivityVote(
                    activity_id=activities[2].id, user_id=users["demo-member"].id, vote="maybe"
                ),
            ]
        )
        session.add_all(
            [
                PlanDateAvailability(
                    plan_id=DEMO_PLAN_ID,
                    user_id=user.id,
                    date=date(2026, 9, 18),
                    status="available",
                )
                for user in users.values()
            ]
        )
        session.add_all(
            [
                ItineraryItem(
                    plan_id=DEMO_PLAN_ID,
                    activity_id=activities[0].id,
                    title=activities[0].name,
                    position_key=Decimal("1000"),
                    starts_at=datetime(2026, 9, 18, 8, 30, tzinfo=timezone.utc),
                    ends_at=datetime(2026, 9, 18, 9, 30, tzinfo=timezone.utc),
                ),
                ItineraryItem(
                    plan_id=DEMO_PLAN_ID,
                    activity_id=activities[1].id,
                    title=activities[1].name,
                    position_key=Decimal("2000"),
                ),
            ]
        )
        await create_expense_rows(
            session,
            DEMO_PLAN_ID,
            owner,
            ExpenseCreate(
                description="Shared campsite",
                amount_cents=15000,
                paid_by_user_id=owner.id,
                participant_user_ids=[user.id for user in users.values()],
            ),
        )
        await recompute_plan_scores(session, DEMO_PLAN_ID)
        await session.commit()
        return "Created deterministic Basecamp demo plan: Redwood Weekend."


def main() -> None:
    print(asyncio.run(seed_demo()))


if __name__ == "__main__":
    main()
