"""Direct owner-pod browser API. No runtime or receipts are constructed here."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import Field

from api.routes.one.pod_session import verified_session
from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused, StrictContract
from hushh_mcp.services.pod_browser.information import InformationField
from hushh_mcp.services.pod_browser.task_contracts import (
    BrowserCapability,
    BrowserOwnerAccess,
    BrowserTaskRequest,
    BrowserTaskSnapshot,
)
from hushh_mcp.services.pod_browser.task_runtime import BrowserTaskRuntime
from hushh_mcp.services.pod_session_authority import (
    ROLE_APP,
    SCOPE_BROWSER_CONTROL,
    SCOPE_BROWSER_INVOKE,
    SCOPE_BROWSER_OBSERVE,
    PodSessionRefused,
)
from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmissionRefused, pod_incarnation


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"


class PrivateBrowserRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                # Default FastAPI errors echo input, which can be a password.
                raise HTTPException(422, detail={"code": "BROWSER_REQUEST_INVALID"}) from None

        return private_handler


router = APIRouter(
    prefix="/api/one/pod/browser",
    tags=["personal-agent"],
    dependencies=[Depends(no_store)],
    route_class=PrivateBrowserRoute,
)


async def owner_access(
    request: Request, authorization: str | None, scope: str
) -> BrowserOwnerAccess:
    authority, claims = verified_session(authorization, role=ROLE_APP, scope=scope)
    if authority.environment not in {"dev", "development"}:
        raise refusal(BrowserRefused("BROWSER_ENVIRONMENT_UNAVAILABLE"))
    incarnation = pod_incarnation()
    if "/tasks/" in request.url.path:
        if request.headers.get("X-Browser-Pod-Incarnation") != incarnation:
            raise refusal(BrowserRefused("BROWSER_INCARNATION_CHANGED"))

    async def check() -> None:
        try:
            current_authority, current_claims = verified_session(
                authorization, role=ROLE_APP, scope=scope
            )
            if (
                current_authority is not authority
                or current_claims != claims
                or pod_incarnation() != incarnation
            ):
                raise BrowserRefused("BROWSER_OWNER_REFUSED")
            await authority.require_held()
        except (PodSessionRefused, HTTPException):
            # Long-running tasks receive stable codes, never bearer/identity details.
            raise BrowserRefused("BROWSER_OWNER_REFUSED") from None

    try:
        await check()
    except BrowserRefused as exc:
        raise refusal(exc) from None
    return BrowserOwnerAccess(
        owner_id=str(claims["user_id"]),
        pod_id=str(claims["hushh_id"]),
        incarnation=incarnation,
        expires_at=int(claims["exp"]),
        check=check,
    )


async def invoking(
    request: Request, authorization: str | None = Header(default=None)
) -> BrowserOwnerAccess:
    return await owner_access(request, authorization, SCOPE_BROWSER_INVOKE)


async def observing(
    request: Request, authorization: str | None = Header(default=None)
) -> BrowserOwnerAccess:
    return await owner_access(request, authorization, SCOPE_BROWSER_OBSERVE)


async def controlling(
    request: Request, authorization: str | None = Header(default=None)
) -> BrowserOwnerAccess:
    return await owner_access(request, authorization, SCOPE_BROWSER_CONTROL)


InvokeOwner = Annotated[BrowserOwnerAccess, Depends(invoking)]
ObserveOwner = Annotated[BrowserOwnerAccess, Depends(observing)]
ControlOwner = Annotated[BrowserOwnerAccess, Depends(controlling)]


def refusal(exc: BrowserRefused) -> HTTPException:
    if exc.code == "BROWSER_TASK_NOT_FOUND":
        status = 404
    elif exc.code in {"BROWSER_OWNER_REFUSED", "BROWSER_BINDING_REFUSED"}:
        status = 403
    elif exc.code in {"BROWSER_FRAME_NOT_READY", "BROWSER_OWNER_APPROVAL_REQUIRED"}:
        status = 409
    elif any(
        word in exc.code
        for word in ("CHANGED", "CONFLICT", "REPLAY", "ACTIVE", "RECOVERY_REQUIRES_OWNER")
    ):
        status = 409
    else:
        status = 503
    return HTTPException(status_code=status, detail={"code": exc.code})


def runtime(request: Request) -> BrowserTaskRuntime:
    installed = getattr(request.app.state, "browser_task_runtime", None)
    if not isinstance(installed, BrowserTaskRuntime):
        raise refusal(BrowserRefused("BROWSER_CLOUD_GATE_UNAVAILABLE"))
    return installed


class CreateTask(StrictContract):
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{8,128}$")
    goal: str = Field(min_length=1, max_length=4096, repr=False)
    allowed_origins: list[str] = Field(min_length=1, max_length=20, repr=False)
    fields: list[InformationField] = Field(default_factory=list, max_length=16)

    def task_request(self) -> BrowserTaskRequest:
        try:
            return BrowserTaskRequest(
                request_id=self.request_id,
                goal=self.goal,
                allowed_origins=tuple(self.allowed_origins),
                fields=tuple(self.fields),
            )
        except ValueError:
            raise HTTPException(422, detail={"code": "BROWSER_TASK_REQUEST_INVALID"}) from None


class ControlRequest(StrictContract):
    operation: Literal["takeover", "resume", "cancel"]
    control_epoch: int = Field(ge=1)


class InputRequest(BrowserAction):
    # FastAPI validates parsed JSON arrays; the execution contract uses tuples.
    keys: list[str] = Field(default_factory=list, max_length=4)

    def action(self) -> BrowserAction:
        values = self.model_dump(exclude_unset=True)
        if "keys" in values:
            values["keys"] = tuple(values["keys"])
        return BrowserAction.model_validate(values)


class ReviewRequest(StrictContract):
    review_id: str = Field(min_length=1, max_length=128)


class SessionRequest(StrictContract):
    operation: Literal["remember", "restore", "forget"]
    origin: str = Field(min_length=1, max_length=4096, repr=False)
    account_id: str = Field(min_length=1, max_length=256, repr=False)


@router.get("/capability", response_model=BrowserCapability)
async def browser_capability(request: Request, owner: ObserveOwner):
    installed = getattr(request.app.state, "browser_task_runtime", None)
    if not isinstance(installed, BrowserTaskRuntime):
        return BrowserCapability(
            available=False,
            code="BROWSER_CLOUD_GATE_UNAVAILABLE",
            owner_id=owner.owner_id,
            pod_id=owner.pod_id,
            incarnation=owner.incarnation,
            environment="development",
        )
    try:
        await installed.require_owner(owner)
        return installed.capability()
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.post("/tasks", response_model=BrowserTaskSnapshot, status_code=202)
async def create_task(request: Request, body: CreateTask, owner: InvokeOwner):
    try:
        return await runtime(request).start(owner, body.task_request())
    except BrowserRefused as exc:
        raise refusal(exc) from None
    except PodUpgradeAdmissionRefused:
        raise refusal(BrowserRefused("BROWSER_DRAINING")) from None


@router.get("/tasks/{task_id}", response_model=BrowserTaskSnapshot)
async def task_status(request: Request, task_id: str, owner: ObserveOwner):
    try:
        return await runtime(request).read(owner, task_id)
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.get("/tasks/{task_id}/frame")
async def task_frame(request: Request, task_id: str, owner: ObserveOwner):
    try:
        snapshot, frame = await runtime(request).frame(owner, task_id)
        return Response(
            frame.png,
            media_type="image/png",
            headers={
                "Cache-Control": "no-store, private",
                "Pragma": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "X-Browser-Control-Epoch": str(snapshot.control_epoch),
                "X-Browser-Pod-Incarnation": snapshot.binding.incarnation,
                "X-Browser-Task-Id": snapshot.binding.task_id,
                "X-Browser-Pod-Id": snapshot.binding.pod_id,
                "X-Browser-Sequence": str(frame.sequence),
                "X-Browser-Next-Sequence": str(snapshot.next_sequence),
                "X-Browser-Revision": str(snapshot.revision),
                "X-Browser-Width": str(frame.width),
                "X-Browser-Height": str(frame.height),
            },
        )
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.post("/tasks/{task_id}/control", response_model=BrowserTaskSnapshot)
async def task_control(request: Request, task_id: str, body: ControlRequest, owner: ControlOwner):
    try:
        return await runtime(request).control(owner, task_id, body.operation, body.control_epoch)
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.post("/tasks/{task_id}/input", response_model=BrowserTaskSnapshot)
async def task_input(request: Request, task_id: str, body: InputRequest, owner: ControlOwner):
    try:
        return await runtime(request).input(owner, task_id, body.action())
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.post("/tasks/{task_id}/review", response_model=BrowserTaskSnapshot)
async def task_review(request: Request, task_id: str, body: ReviewRequest, owner: ControlOwner):
    try:
        return await runtime(request).confirm_review(owner, task_id, body.review_id)
    except BrowserRefused as exc:
        raise refusal(exc) from None


@router.post("/tasks/{task_id}/session")
async def task_session(request: Request, task_id: str, body: SessionRequest, owner: ControlOwner):
    try:
        return await runtime(request).session(
            owner, task_id, body.operation, body.origin, body.account_id
        )
    except BrowserRefused as exc:
        raise refusal(exc) from None
