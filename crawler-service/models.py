from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class MatcherConfig(BaseModel):
    attributes: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    placeholders: list[str] = Field(default_factory=list)
    types: list[str] = Field(default_factory=list)


class TemplateKey(BaseModel):
    key: str
    value: str
    matchers: MatcherConfig = Field(default_factory=MatcherConfig)


class SessionCookie(BaseModel):
    name: str
    value: str
    domain: Optional[str] = None
    path: str = "/"
    same_site: Literal["Strict", "Lax", "None"] = "Lax"
    secure: bool = False


class CrawlUrlConfig(BaseModel):
    url: str
    depth: int = 1
    max_actions: int = Field(100, alias="maxActions")
    max_states: int = Field(50, alias="maxStates")
    allowed_domains: list[str] = Field(default_factory=list, alias="allowedDomains")
    single_url_mode: bool = Field(True, alias="singleUrlMode")

    class Config:
        populate_by_name = True


class CrawlConfig(BaseModel):
    urls: list[CrawlUrlConfig]
    template_keys: list[TemplateKey] = Field(default_factory=list, alias="templateKeys")
    session_cookies: list[SessionCookie] = Field(default_factory=list, alias="sessionCookies")
    browser_mode: Literal["headless", "visual"] = Field("headless", alias="browserMode")
    single_url_mode: bool = Field(True, alias="singleUrlMode")

    class Config:
        populate_by_name = True


# ── Output types ──────────────────────────────────────────────────────────────

class CrawlAction(BaseModel):
    id: str
    type: str
    target_selector: str = Field("", alias="targetSelector")
    state_before: str = Field("", alias="stateBefore")
    state_after: str = Field("", alias="stateAfter")
    url: str
    timestamp: str

    class Config:
        populate_by_name = True


class CrawlEvent(BaseModel):
    id: str
    action_id: Optional[str] = Field(None, alias="actionId")
    event_type: str = Field(alias="eventType")
    technology: str
    event_name: str = Field(alias="eventName")
    url: str
    state_name: str = Field(alias="stateName")
    parameters: dict = Field(default_factory=dict)
    consent_state: str = Field("unknown", alias="consentState")
    status: str = "observed"
    correlation_confidence: str = Field("low", alias="correlationConfidence")
    timestamp: str

    class Config:
        populate_by_name = True


class IgnoredField(BaseModel):
    field_name: str = Field(alias="fieldName")
    css_selector: str = Field(alias="cssSelector")
    reason: Literal["no_mapping", "ambiguous_mapping", "unsupported_type"]

    class Config:
        populate_by_name = True


class CrawlWarning(BaseModel):
    type: str
    message: str


class CrawlOutput(BaseModel):
    status: Literal["completed", "paused", "failed"]
    stop_reason: Optional[str] = Field(None, alias="stopReason")
    actions: list[CrawlAction] = Field(default_factory=list)
    events: list[CrawlEvent] = Field(default_factory=list)
    ignored_fields: list[IgnoredField] = Field(default_factory=list, alias="ignoredFields")
    warnings: list[CrawlWarning] = Field(default_factory=list)
    states_discovered: int = Field(0, alias="statesDiscovered")
    state_screenshots: dict[str, str] = Field(default_factory=dict, alias="stateScreenshots")

    class Config:
        populate_by_name = True
