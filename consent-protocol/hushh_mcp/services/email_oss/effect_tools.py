"""Thin Gmail effect hands; authority stays in ToolState and existing review ports."""


class GmailEffectTools:
    def __init__(self, state):
        self.state = state

    async def create_draft(self, **arguments):
        return await self.state.invoke("create_draft", arguments)

    async def send_email(self, **arguments):
        return await self.state.invoke("send_email", arguments, mutation=True)

    async def reply_to_thread(self, **arguments):
        return await self.state.invoke("reply_to_thread", arguments, mutation=True)

    async def batch_modify_messages(self, **arguments):
        return await self.state.invoke("batch_modify_messages", arguments, mutation=True)

    async def trash_message(self, message_id: str):
        return await self.state.invoke("trash_message", {"message_id": message_id}, mutation=True)
