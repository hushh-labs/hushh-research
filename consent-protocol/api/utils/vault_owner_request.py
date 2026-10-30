"""Parse the existing owner-token request without granting authority."""

from fastapi import HTTPException, Request


async def read_owner_request(request: Request) -> tuple[dict, str]:
    body = await request.json()
    user_id = body.get("userId")
    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")
    return body, user_id
