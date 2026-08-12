"""Application settings for Basecamp."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    jwt_secret: str
    environment: str = "local"
    cors_allowed_origins: str = "http://localhost:3000"
    # Vercel exposes immutable deployment URLs in addition to the stable project
    # alias. Restrict this to this project's team-scoped hostname rather than
    # allowing arbitrary ``*.vercel.app`` origins.
    cors_allowed_origin_regex: str | None = r"https://basecamp(?:-[a-z0-9]+)?-trees6\.vercel\.app"
    # Application administration is deliberately independent from plan roles.
    admin_emails: str = ""
    cleanup_enabled: bool = True
    # Off by default so test/import and reload processes do not grow schedulers.
    cleanup_scheduler_enabled: bool = False
    cleanup_interval_minutes: int = 30
    cleanup_batch_size: int = 100

    @property
    def admin_email_set(self) -> frozenset[str]:
        return frozenset(
            email.strip().lower() for email in self.admin_emails.split(",") if email.strip()
        )

    @property
    def cors_origins(self) -> list[str]:
        # Browser origins never include a trailing slash. Normalizing the
        # deployment setting keeps an explicitly configured Vercel origin from
        # being accidentally rejected when it is entered with one.
        return [
            origin.strip().rstrip("/")
            for origin in self.cors_allowed_origins.split(",")
            if origin.strip()
        ]

    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
